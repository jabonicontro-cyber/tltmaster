-- Rollback of 20261120020000_demo_driver_report_samples.sql (not a migration; run by hand after a backup). Removes the
-- sample function and its two helpers; Refresh then skips driver report samples (src/server/demo/samples.ts treats the
-- missing function as "not installed"). Sample reports already added stay, like any record a demo holds, and go with
-- their sample order when sample data is removed. No other data is touched.
begin;
drop function if exists public.demo_field_report_samples();
drop function if exists private.demo_report_add(uuid, text, text, text, text, text, uuid);
drop function if exists private.demo_report_assignment(uuid, date, date, uuid[], boolean);
commit;
