-- Rollback of 20261120002800_demo_auto_refresh.sql (not a migration; run by hand with a backup first).
-- Drops only the automatic-refresh bookkeeping; demo data is untouched. The app falls back to the manual button.
begin;
drop function if exists public.demo_auto_refresh_finish(text, date, boolean, text);
drop function if exists public.demo_auto_refresh_claim(text, date);
drop function if exists private.demo_owner_company();
drop table if exists private.demo_refresh_state;
commit;
