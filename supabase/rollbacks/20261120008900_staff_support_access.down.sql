-- Rollback for 20261120008900_staff_support_access.sql (SA1). Restores the identity functions as they were after
-- 20261120006300 / 20261120001100, then removes support visits, customer grants, staff invites and staff levels.
-- Staff with the support level lose console access entirely (their rows are removed only if level = 'support';
-- admins keep theirs). Grants, visits and invites are lost; the platform and company audit entries stay.

-- Ended visits stop working the moment the identity functions are restored.
CREATE OR REPLACE FUNCTION private.is_platform_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select auth.uid() is not null
     and exists (select 1 from private.platform_admins a where a.user_id = auth.uid() and a.revoked_at is null)
$function$

;

CREATE OR REPLACE FUNCTION public.mfa_policy()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select jsonb_build_object(
    'platform', private.is_platform_admin() and private.platform_mfa_enforced(),
    'companies', coalesce((select jsonb_agg(c.name order by c.name)
                           from public.company_memberships m
                           join public.companies c on c.id = m.company_id and c.active
                           join public.company_settings s on s.company_id = c.id
                           where m.user_id = auth.uid() and m.active and s.require_mfa), '[]'::jsonb),
    'current_company', coalesce((select s.require_mfa from public.company_settings s where s.company_id = private.current_company_id_any()), false),
    'enrolled', private.mfa_enrolled(),
    'recovery_codes', (select count(*) from private.mfa_recovery_codes r where r.user_id = auth.uid() and r.used_at is null),
    'recent_failures', (select count(*) from private.mfa_attempts a where a.user_id = auth.uid() and not a.ok and a.at > now() - interval '15 minutes'),
    'aal2', private.aal2());
$function$

;

CREATE OR REPLACE FUNCTION private.current_company_id()
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  -- One query, cheapest test first (it runs inside most row-level security policies). Same membership choice as
  -- private.current_company_id_any(). No company below aal2 for enrolled/required two-step (20261120001100), none
  -- while first sign-in setup is pending (20261120001200), and none once a time-limited access ended (20261120006300).
  select case
    when x.company_id is null then null
    when exists (select 1 from private.account_setups s where s.user_id = auth.uid() and s.status = 'setup_required') then null
    when coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2' then x.company_id
    when exists (select 1 from auth.mfa_factors f where f.user_id = auth.uid() and f.status = 'verified') then null
    when coalesce((select s.require_mfa from public.company_settings s where s.company_id = x.company_id), false) then null
    else x.company_id
  end
  from (select (
    select m.company_id
    from public.company_memberships m
    join public.companies c on c.id = m.company_id and c.active
    join public.profiles p on p.id = m.user_id
    where m.user_id = auth.uid()
      and m.active
      and m.role is not null
      and (m.access_ends_at is null or m.access_ends_at > now())
    order by (m.company_id = p.active_company_id) desc nulls last, m.created_at, m.company_id
    limit 1) as company_id) x
$function$

;

CREATE OR REPLACE FUNCTION private.current_company_id_any()
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select m.company_id
  from public.company_memberships m
  join public.companies c on c.id = m.company_id and c.active
  join public.profiles p on p.id = m.user_id
  where m.user_id = auth.uid()
    and m.active
    and m.role is not null
    and (m.access_ends_at is null or m.access_ends_at > now())
  order by (m.company_id = p.active_company_id) desc nulls last, m.created_at, m.company_id
  limit 1
$function$

;

CREATE OR REPLACE FUNCTION private.has_permission(p_permission text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select exists (
    select 1
    from public.company_memberships m
    join public.role_permissions rp
      on rp.company_id = m.company_id and rp.role = m.role
    where m.user_id = auth.uid()
      and m.company_id = private.current_company_id()
      and m.active
      and rp.permission = p_permission
  )
$function$

;

CREATE OR REPLACE FUNCTION private.current_app_role()
 RETURNS app_role
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select m.role
  from public.company_memberships m
  where m.user_id = auth.uid()
    and m.company_id = private.current_company_id()
$function$

;

CREATE OR REPLACE FUNCTION private.require_owner()
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_company uuid := private.require_company();
begin
  if not exists (select 1 from public.company_memberships m where m.company_id = v_company and m.user_id = auth.uid() and m.active and m.role = 'owner') then
    raise exception 'Only an owner can give or change an accountant''s access.' using errcode = '42501';
  end if;
  return v_company;
end;
$function$

;

CREATE OR REPLACE FUNCTION public.my_access()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  with cur as (select private.current_company_id() as company_id),
  m as (
    -- The current company's membership, or (for users waiting for access) any membership.
    select m.*
    from public.company_memberships m, cur
    where m.user_id = auth.uid()
    order by (m.company_id = cur.company_id) desc nulls last, m.created_at
    limit 1
  )
  select jsonb_build_object(
    'user_id', p.id,
    'email', p.email,
    'full_name', p.full_name,
    'company_id', cur.company_id,
    'company_name', (select c.name from public.companies c where c.id = cur.company_id),
    'role', case when cur.company_id is not null then m.role end,
    'active', coalesce(m.active, true) and (m.company_id is null or exists (select 1 from public.companies c where c.id = m.company_id and c.active)),
    'membership_count', (select count(*) from public.company_memberships x where x.user_id = p.id and x.active and x.role is not null),
    'permissions', coalesce(
      (select jsonb_agg(rp.permission order by rp.permission)
       from public.role_permissions rp
       where cur.company_id is not null and rp.company_id = cur.company_id and rp.role = m.role and m.active),
      '[]'::jsonb)
  )
  from public.profiles p
  cross join cur
  left join m on true
  where p.id = auth.uid()
$function$

;

drop trigger if exists z_no_support_visit on public.company_memberships;
drop trigger if exists z_no_support_visit on public.role_permissions;
drop trigger if exists z_no_support_visit on public.portal_accounts;
drop trigger if exists z_no_support_visit on public.telematics_settings;
drop trigger if exists z_no_support_visit on private.account_setups;
drop trigger if exists z_no_support_visit on private.account_provisions;
drop trigger if exists z_no_support_visit on public.company_settings;
drop function if exists private.forbid_during_support_visit();
alter table private.company_lifecycle drop column if exists created_at;
drop policy if exists companies_read_support on public.companies;

drop function if exists public.platform_staff_remove(uuid, text);
drop function if exists public.platform_support_leave();
drop function if exists public.platform_support_enter(uuid, text);
drop function if exists public.platform_support_companies();
drop function if exists public.support_actor_names();
drop function if exists public.support_access_status();
drop function if exists public.support_access_end();
drop function if exists public.support_access_grant(integer);
drop function if exists private.staff_name(uuid);
drop function if exists private.support_audit(uuid, text, text, jsonb);
drop function if exists private.support_company();
drop table if exists private.support_sessions;
drop function if exists private.support_open_grant(uuid);
drop function if exists private.support_needs_grant(uuid);
drop table if exists public.support_access_grants;

drop function if exists public.platform_staff_set_level(uuid, text);
drop function if exists public.platform_staff_list();
drop function if exists public.platform_staff_accept(text);
drop function if exists public.staff_invite_peek(text);
drop function if exists public.platform_staff_invites();
drop function if exists public.platform_staff_invite_revoke(uuid);
drop function if exists public.platform_staff_invite(text, text, text);
drop function if exists private.staff_token_hash(text);
drop table if exists private.platform_staff_invites;
drop function if exists private.require_fresh_reauth();

drop function if exists public.platform_staff_whoami();
drop function if exists private.require_platform_staff();
drop function if exists private.is_platform_staff();
update private.platform_admins set revoked_at = coalesce(revoked_at, now()), revoke_note = 'Support level removed by rollback' where level = 'support';
alter table private.platform_admins drop column if exists level;
