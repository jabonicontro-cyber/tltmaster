-- Rollback of 20261120003100_maintenance_triage.sql (not a migration; run by hand with a backup first).
-- DESTRUCTIVE for data entered since: triage suggestions and their history lines are removed. Category, urgency and
-- safety flags already applied to work orders stay as they are.
begin;
drop function if exists public.maintenance_decide_triage(uuid, text, text, text, boolean, text);
drop function if exists public.maintenance_save_triage(uuid, text, text, jsonb);
drop table if exists public.work_order_triage;
delete from public.work_order_events where kind = 'triage';
alter table public.work_order_events drop constraint work_order_events_kind_check;
alter table public.work_order_events add constraint work_order_events_kind_check check (kind in (
  'created', 'updated', 'status', 'assigned', 'scheduled', 'rescheduled', 'unscheduled', 'canceled',
  'inspection_started', 'inspection_failed', 'cleared', 'restricted', 'returned_to_service',
  'crew', 'time', 'task'));
commit;
