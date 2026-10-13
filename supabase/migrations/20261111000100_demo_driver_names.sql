-- =============================================================================
-- Demo driver names (docs/DEMO_TENANTS.md §2).
--
-- In a demo company the person presenting is shown as the demo's fictional
-- persona (e.g. "Daniel Mitchell"): the header, greeting and Communications
-- already use the persona's employee record (private.comm_user_name,
-- 20261108000100). driver_list still named a driver linked to a login by the
-- login's own profile name, so Plan the day, Dispatch, Delivery Tickets and the
-- driver directory showed the presenter's real name next to the persona.
--
-- Change: in a demo company only, a driver's own record name wins over the
-- linked login's name. Real companies are unchanged (the login's name first,
-- as before). Same columns, same security_invoker view and grants.
--
-- Additive and safe to skip: without it the app works and demos keep the old
-- naming. Rollback: supabase/rollbacks/20261111000100_demo_driver_names.down.sql.
-- =============================================================================

create or replace view public.driver_list
with (security_invoker = true) as
select
  d.id,
  d.company_id,
  d.user_id,
  coalesce(
    case when c.is_demo then nullif(trim(d.name), '') end,
    nullif(trim(ms.full_name), ''),
    nullif(d.name, ''),
    'Unnamed driver'
  ) as display_name,
  d.name,
  d.employee_number,
  d.phone,
  d.hire_date,
  d.active,
  d.notes,
  d.created_at,
  d.updated_at,
  ms.active as account_active,
  ms.role as account_role
from public.drivers d
left join public.companies c on c.id = d.company_id
left join lateral private.member_summary(d.user_id) ms on d.user_id is not null;

revoke all on public.driver_list from anon, authenticated;
grant select on public.driver_list to authenticated;
grant select on public.driver_list to service_role;
