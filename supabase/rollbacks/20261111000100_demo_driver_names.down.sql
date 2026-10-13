-- Rollback of 20261111000100_demo_driver_names.sql (not a migration; run by hand with a backup first).
-- Restores driver_list as defined in 20261013000100_fleet_registry.sql: the linked login's name first everywhere.
begin;
create or replace view public.driver_list
with (security_invoker = true) as
select
  d.id,
  d.company_id,
  d.user_id,
  coalesce(nullif(trim(ms.full_name), ''), nullif(d.name, ''), 'Unnamed driver') as display_name,
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
left join lateral private.member_summary(d.user_id) ms on d.user_id is not null;
revoke all on public.driver_list from anon, authenticated;
grant select on public.driver_list to authenticated;
grant select on public.driver_list to service_role;
commit;
