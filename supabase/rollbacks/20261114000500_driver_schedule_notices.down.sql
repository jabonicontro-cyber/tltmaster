-- Rollback of 20261114000500_driver_schedule_notices.sql (not a migration; run by hand with a backup first).
-- Stops the new notices. Alerts already raised stay in the history; the two event types stay registered (removing
-- them would break that history), and companies can turn them off in alert settings.
begin;
drop trigger if exists alerts_new_assignments on public.dispatch_assignments;
drop trigger if exists alerts_load_changes on public.order_loads;
drop function if exists private.alerts_from_new_assignments();
drop function if exists private.alerts_from_load_changes();
drop function if exists private.load_schedule_label(uuid);
commit;
