-- Rollback for 20261120006000_vehicle_inspections.sql. Forgets inspections; work orders opened from them stay, marked
-- as manual (their source 'inspection' is not allowed before this migration).
begin;
drop function if exists public.demo_inspection_samples();
drop function if exists public.inspection_missing_today();
drop function if exists public.inspection_my_trucks();
drop function if exists public.inspection_submit(jsonb);
drop function if exists private.inspection_items();
drop table if exists public.vehicle_inspections;
update public.work_orders set source = 'manual' where source = 'inspection';
alter table public.work_orders drop constraint work_orders_source_check;
alter table public.work_orders add constraint work_orders_source_check check (source in ('manual', 'field_report', 'preventive'));
commit;
