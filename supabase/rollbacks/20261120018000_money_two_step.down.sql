-- Rollback of 20261120018000_money_two_step.sql (not a migration; run by hand after a backup). Restores
-- private.current_company_id() and public.mfa_policy() as 20261120008900 left them and private.log_event() as
-- 20261011000200 left it, restores private.support_company() (20261120008900), then removes the money list and check
-- and the recovery-code confirmations. Money access then needs two-step verification only when the person set up an
-- authenticator or their company requires it, and recovery codes are optional again.
begin;

CREATE OR REPLACE FUNCTION private.current_company_id()
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  -- One query, cheapest test first (it runs inside most row-level security policies). Same membership choice as
  -- private.current_company_id_any(). No company below aal2 for enrolled/required two-step (20261120001100), none
  -- while first sign-in setup is pending (20261120001200), and none once a time-limited access ended (20261120006300).
  -- A Taviron support visit (20261120008900) takes precedence while it lasts.
  select coalesce(private.support_company(), (
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
    limit 1) as company_id) x))
$function$;

CREATE OR REPLACE FUNCTION public.mfa_policy()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select jsonb_build_object(
    'platform', private.is_platform_staff() and private.platform_mfa_enforced(),
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
$function$;

CREATE OR REPLACE FUNCTION private.log_event(p_action text, p_entity_type text, p_entity_id uuid, p_summary text, p_details jsonb DEFAULT '{}'::jsonb)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  insert into public.audit_events (company_id, actor_id, action, entity_type, entity_id, summary, details)
  values (private.current_company_id(), auth.uid(), p_action, p_entity_type, p_entity_id,
          coalesce(p_summary, ''), coalesce(p_details, '{}'::jsonb));
$function$;

-- Support visits: as 20261120008900 left it (the emergency switch lifts the two-step requirement for visits too).
CREATE OR REPLACE FUNCTION private.support_company()
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select s.company_id
  from private.support_sessions s
  join public.companies c on c.id = s.company_id and c.active
  join private.platform_admins a on a.user_id = s.user_id and a.revoked_at is null
  where s.user_id = auth.uid() and s.ended_at is null and s.ends_at > now()
    and (not private.platform_mfa_enforced() or private.aal2())
    and (case when s.grant_id is null then not private.support_needs_grant(s.company_id)
              else exists (select 1 from public.support_access_grants g where g.id = s.grant_id and g.ended_at is null and g.ends_at > now()) end)
  order by s.started_at desc
  limit 1
$function$;

-- Recovery-code confirmations are lost (recovery codes themselves stay).
drop function if exists public.mfa_recovery_confirm();
drop function if exists private.mfa_recovery_ready();
drop table if exists private.mfa_recovery_confirmations;
drop function if exists private.money_mfa_required();
-- private.is_money_permission back to its 20261120017100 definition (its own list) before the shared list goes.
create or replace function private.is_money_permission(p_permission text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(p_permission like 'billing.%' or p_permission like 'pricing.%'
    or p_permission in ('payroll.manage', 'employees.compensation', 'accounting.view', 'maintenance.costs', 'audit.view',
      -- Company settings set the default sales tax rate; user management can hand any money permission to any account.
      'settings.manage', 'users.manage'), false);
$$;
revoke all on function private.is_money_permission(text) from public, anon, authenticated;
drop function if exists private.money_permissions();

commit;
