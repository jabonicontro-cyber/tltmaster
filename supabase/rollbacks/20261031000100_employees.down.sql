-- Reverses supabase/migrations/20261031000100_employees.sql.
-- NOT a migration: run by hand, only after a backup and only if the founder asks.
-- Employee records, pay details and drivers' primary trucks are deleted.
begin;
drop function if exists public.set_driver_primary_truck(uuid, uuid);
drop trigger if exists drivers_primary_truck_guard on public.drivers;
drop function if exists private.guard_primary_truck();
drop index if exists public.drivers_primary_truck_key;
alter table public.drivers drop constraint if exists drivers_primary_truck_fk;
alter table public.drivers drop column if exists primary_truck_id;
drop table if exists public.employee_compensation;
drop table if exists public.employees;
drop function if exists private.audit_compensation_change();
drop function if exists private.stamp_employee_row();
delete from public.role_permissions where permission in ('employees.view', 'employees.edit', 'employees.compensation', 'fleet.assign');
delete from public.role_permission_defaults where permission in ('employees.view', 'employees.edit', 'employees.compensation', 'fleet.assign');
delete from public.permissions where code in ('employees.view', 'employees.edit', 'employees.compensation', 'fleet.assign');
commit;
