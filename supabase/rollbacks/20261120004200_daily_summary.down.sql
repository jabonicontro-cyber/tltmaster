-- Rollback for 20261120004200_daily_summary.sql: the summary settings, log and functions.
drop function if exists public.daily_summary_record(uuid, date, text, integer, text);
drop function if exists public.daily_summary_due();
drop function if exists public.my_daily_summary(date);
drop function if exists private.daily_summary(uuid, date);
drop table if exists public.daily_summary_log;
revoke update (daily_summary_enabled, daily_summary_hour) on public.company_settings from authenticated;
alter table public.company_settings drop column if exists daily_summary_enabled, drop column if exists daily_summary_hour;
