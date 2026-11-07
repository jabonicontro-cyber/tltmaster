-- Rollback for 20261120009200_support_change_requests.sql (not a migration). Restores my_access as in
-- 20261120008900 and removes the support change requests (pending requests are discarded; nothing they described ran).
begin;
drop function if exists public.support_change_withdraw(uuid);
drop function if exists public.support_change_decline(uuid);
drop function if exists public.support_change_finish(uuid, boolean, text);
drop function if exists public.support_change_claim(uuid);
drop function if exists public.support_change_requests();
drop function if exists public.support_change_request(text, jsonb, text, jsonb, text);
drop function if exists private.is_real_owner();
drop table if exists private.support_change_requests;
CREATE OR REPLACE FUNCTION public.my_access()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  with cur as (select private.current_company_id() as company_id, private.support_company() as support_company),
  m as (
    -- The current company's membership, or (for users waiting for access) any membership.
    select m.*
    from public.company_memberships m, cur
    where m.user_id = auth.uid()
    order by (m.company_id = cur.company_id) desc nulls last, m.created_at
    limit 1
  ),
  visit as (
    select s.ends_at, s.started_at from private.support_sessions s, cur
    where cur.support_company is not null and s.user_id = auth.uid() and s.company_id = cur.support_company and s.ended_at is null
    order by s.started_at desc limit 1
  )
  select jsonb_build_object(
    'user_id', p.id,
    'email', p.email,
    'full_name', p.full_name,
    'company_id', cur.company_id,
    'company_name', (select c.name from public.companies c where c.id = cur.company_id),
    'role', case when cur.support_company is not null then 'owner'::public.app_role when cur.company_id is not null then m.role end,
    'active', case when cur.support_company is not null then true
                   else coalesce(m.active, true) and (m.company_id is null or exists (select 1 from public.companies c where c.id = m.company_id and c.active)) end,
    'membership_count', (select count(*) from public.company_memberships x where x.user_id = p.id and x.active and x.role is not null),
    'permissions', coalesce(
      (select jsonb_agg(rp.permission order by rp.permission)
       from public.role_permissions rp
       where cur.company_id is not null and rp.company_id = cur.company_id
         and ((cur.support_company is not null and rp.role = 'owner')
              or (cur.support_company is null and rp.role = m.role and m.active))),
      '[]'::jsonb),
    'support', (select jsonb_build_object('ends_at', v.ends_at, 'started_at', v.started_at) from visit v),
    'support_inside', coalesce(cur.support_company is null and cur.company_id is not null and m.role = 'owner'
      and exists (select 1 from private.support_sessions s where s.company_id = cur.company_id and s.ended_at is null and s.ends_at > now()), false)
  )
  from public.profiles p
  cross join cur
  left join m on true
  where p.id = auth.uid()
$function$

;
commit;
