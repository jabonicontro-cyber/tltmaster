-- Rollback of 20261120003200_demo_refresh_lock.sql (not a migration; run by hand with a backup first).
-- The manual refresh then runs without the lock again (the app treats the missing functions as "no lock").
begin;
drop function if exists public.demo_refresh_end(text, date, boolean);
drop function if exists public.demo_refresh_begin();
commit;
