-- Reverses supabase/migrations/20261101000100_maintenance.sql.
-- NOT a migration: run by hand, only after a backup and only if the founder asks.
-- Work orders, their history and costs, preventive schedules and truck readings
-- are deleted. Trucks keep their current service status.
begin;
drop function if exists public.maintenance_assignee_options();
drop function if exists public.driver_maintenance_notices();
drop function if exists public.maintenance_generate_due();
drop function if exists public.maintenance_record_clearance(uuid, text, text);
drop function if exists public.maintenance_start_inspection(uuid);
drop function if exists public.maintenance_set_status(uuid, text, text, integer);
drop function if exists public.maintenance_update_work_order(uuid, integer, jsonb);
drop function if exists public.maintenance_create_work_order(jsonb);
drop function if exists public.maintenance_save_schedule(jsonb);
drop function if exists public.record_truck_reading(uuid, numeric, numeric, text);
drop function if exists public.maintenance_pm_status();
drop function if exists private.pm_due(uuid);
drop function if exists private.wo_validate_refs(uuid, uuid, uuid, uuid);
drop function if exists private.wo_complete_schedule(uuid);
drop function if exists private.wo_release_truck(uuid);
drop function if exists private.wo_restrict_truck(uuid);
drop function if exists private.wo_transition_ok(text, text);
drop function if exists private.wo_event(uuid, uuid, text, text, text, text, jsonb);
drop trigger if exists trucks_clearance_guard on public.trucks;
drop function if exists private.guard_truck_clearance();
drop table if exists public.work_order_costs;
drop function if exists private.guard_work_order_cost();
drop table if exists public.work_order_events;
drop table if exists public.work_orders;
drop table if exists public.maintenance_schedules;
drop table if exists public.truck_readings;
drop trigger if exists companies_work_order_sequence on public.companies;
drop function if exists private.add_work_order_sequence();
delete from public.document_sequences where key = 'work_order';
alter table public.document_sequences drop constraint document_sequences_key_check;
alter table public.document_sequences add constraint document_sequences_key_check
  check (key in ('customer', 'quote', 'order', 'ticket', 'billing'));
delete from public.role_permissions where permission like 'maintenance.%';
delete from public.role_permission_defaults where permission like 'maintenance.%';
delete from public.permissions where code like 'maintenance.%';
commit;
