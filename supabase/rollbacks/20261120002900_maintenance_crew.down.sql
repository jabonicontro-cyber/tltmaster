-- Rollback of 20261120002900_maintenance_crew.sql (not a migration; run by hand with a backup first).
-- DESTRUCTIVE for data entered since: crews, time entries and task checklists are removed, and their history lines.
-- work_orders.labor_hours keeps its last value; the lead stays in work_orders.assigned_to.
begin;
drop trigger if exists work_orders_no_running_timer on public.work_orders;
drop trigger if exists work_orders_sync_lead on public.work_orders;
drop function if exists public.maintenance_set_task(uuid, text);
drop function if exists public.maintenance_add_task(uuid, text);
drop function if exists public.maintenance_void_time(uuid, text);
drop function if exists public.maintenance_add_time(uuid, uuid, timestamptz, timestamptz, text);
drop function if exists public.maintenance_stop_timer(text);
drop function if exists public.maintenance_start_timer(uuid, text);
drop function if exists public.maintenance_set_my_status(uuid, text);
drop function if exists public.maintenance_remove_mechanic(uuid, uuid);
drop function if exists public.maintenance_add_mechanic(uuid, uuid, boolean);
drop function if exists private.wo_no_running_timer();
drop function if exists private.wo_sync_lead();
drop function if exists private.wo_sync_labor(uuid);
drop function if exists private.wo_person_name(uuid);
drop function if exists private.can_be_mechanic(uuid, uuid);
drop function if exists private.wo_for_crew(uuid);
drop table if exists public.work_order_tasks;
drop table if exists public.work_order_time_entries;
drop table if exists public.work_order_mechanics;
delete from public.work_order_events where kind in ('crew', 'time', 'task');
alter table public.work_order_events drop constraint work_order_events_kind_check;
alter table public.work_order_events add constraint work_order_events_kind_check check (kind in (
  'created', 'updated', 'status', 'assigned', 'scheduled', 'rescheduled', 'unscheduled', 'canceled',
  'inspection_started', 'inspection_failed', 'cleared', 'restricted', 'returned_to_service'));
commit;
