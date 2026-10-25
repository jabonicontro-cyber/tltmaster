-- Rollback of 20261120003300_shift_scheduling.sql (not a migration; run by hand with a backup first).
-- Removes shift scheduling and the dispatch shift check. Schedules, one-day changes, their history and the recorded
-- off-shift reasons are deleted with the tables (back them up first if they matter). Assignments themselves stay.
begin;
drop trigger if exists dispatch_assignments_shift_record on public.dispatch_assignments;
drop trigger if exists dispatch_assignments_shift_check on public.dispatch_assignments;
drop function if exists public.assign_load_off_shift(uuid, uuid, uuid, uuid, text, uuid, text);
drop function if exists private.dispatch_shift_record();
drop function if exists private.dispatch_shift_check();
drop function if exists private.driver_shift_problem(uuid, uuid, uuid);
drop function if exists public.schedule_clear_day(uuid, date);
drop function if exists public.schedule_set_day(uuid, date, text, time, time, integer, text);
drop function if exists public.schedule_end_pattern(uuid, date);
drop function if exists public.schedule_set_pattern(uuid, text, integer, date, date, jsonb, text);
drop function if exists private.schedule_employee(uuid);
drop function if exists public.schedule_range(date, integer);
drop function if exists private.shift_on(uuid, uuid, date);
drop function if exists private.clock_text(time);
drop table if exists public.assignment_shift_overrides;
drop table if exists public.schedule_events;
drop table if exists public.shift_changes;
drop table if exists public.shift_pattern_days;
drop table if exists public.shift_patterns;
drop function if exists private.can_see_schedule(uuid, uuid);
delete from public.role_permissions where permission = 'schedules.manage';
delete from public.role_permission_defaults where permission = 'schedules.manage';
delete from public.permissions where code = 'schedules.manage';
commit;
