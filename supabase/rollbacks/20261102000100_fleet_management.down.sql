-- Reverses supabase/migrations/20261102000100_fleet_management.sql.
-- NOT a migration: run by hand, only after a backup and only if the founder asks.
-- Vehicle documents, assignment history and recorded ownership are deleted.
-- Drivers keep their current primary trucks.
begin;
drop function if exists public.assign_truck_driver(uuid, uuid);
drop trigger if exists drivers_truck_assignment_history on public.drivers;
drop function if exists private.record_truck_assignment();
drop table if exists public.truck_assignment_events;
drop table if exists public.vehicle_documents;
drop function if exists private.stamp_vehicle_document();
alter table public.trailers drop column if exists ownership;
alter table public.trucks drop column if exists ownership;
alter table public.work_order_events alter column created_at set default now();
commit;
