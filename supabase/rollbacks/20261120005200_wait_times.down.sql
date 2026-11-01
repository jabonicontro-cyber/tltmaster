-- Rollback for 20261120005200_wait_times.sql (B111). Removes recorded arrival/departure times and the free time.
begin;
drop function if exists public.demo_wait_time_samples();
drop function if exists public.load_stop_set(uuid, text, timestamptz, timestamptz, uuid);
drop function if exists public.load_stop_mark(uuid, text, text, uuid);
drop function if exists private.stop_time_writer(uuid);
drop function if exists public.wait_time_save_settings(integer);
drop table if exists public.load_stop_times;
drop table if exists public.wait_time_settings;
commit;
