-- =============================================================================
-- Shift scheduling and the dispatch shift check (owner decisions 2026-10-25).
--
-- Decisions: companies need fixed weekly times, rotations (e.g. 4 on / 4 off, week A / week B), overnight shifts and
-- week-by-week schedules built by hand. Owner, office and dispatch create and change schedules (new permission
-- schedules.manage); drivers and mechanics see their own. When dispatch assigns a load to a driver who is scheduled
-- off (day off, before the shift starts or after it ends), the assignment is stopped with the reason ("Not on shift:
-- works 6:00 AM–4:30 PM") and can still be made with a written reason, which is recorded. A driver with no schedule at
-- all is not checked (the schedule shows "No schedule").
--
--   shift_patterns      a person's repeating pattern: weekly (7-day cycle starting on a Monday) or a rotation of
--                       1–56 days from an anchor date, with effective dates. A new pattern ends the previous one the
--                       day before it starts, so the history stays; patterns never overlap.
--   shift_pattern_days  the shifts in a pattern by day of the cycle: start, end (an end at or before the start ends
--                       the next day: overnight) and unpaid break minutes. A day without a row is a day off.
--   shift_changes       one date for one person: a shift (also how a week-by-week schedule is built) or a day off,
--                       with an optional reason. It replaces the pattern on that date.
--   schedule_events     who changed what and when (pattern set or ended, day changed or cleared).
--   assignment_shift_overrides  assignments made outside the driver's shift: the problem shown and the reason given.
--
-- Every change goes through the functions below (schedules.manage, same company, validated). Reads: people with
-- employees.view, dispatch.view or schedules.manage see the company's schedules; everyone sees their own.
-- Reversible: supabase/rollbacks/20261120003300_shift_scheduling.down.sql
-- =============================================================================

insert into public.permissions (code, category, description) values
  ('schedules.manage', 'People', 'Create and change shifts and schedules: weekly patterns, rotations and one-day changes');
insert into public.role_permission_defaults (role, permission) values
  ('owner', 'schedules.manage'), ('office', 'schedules.manage'), ('dispatcher', 'schedules.manage');
insert into public.role_permissions (company_id, role, permission)
select c.id, d.role, d.permission from public.companies c cross join public.role_permission_defaults d
where d.permission = 'schedules.manage'
on conflict do nothing;

create table public.shift_patterns (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null default private.current_company_id() references public.companies (id),
  employee_id     uuid not null,
  kind            text not null check (kind in ('weekly', 'rotation')),
  cycle_days      integer not null check (cycle_days between 1 and 56),
  anchor_date     date not null,
  effective_from  date not null,
  effective_to    date,
  note            text not null default '',
  created_by      uuid default auth.uid() references auth.users (id) on delete set null,
  created_at      timestamptz not null default now(),
  foreign key (company_id, employee_id) references public.employees (company_id, id) on delete cascade,
  check (effective_to is null or effective_to >= effective_from),
  check (kind <> 'weekly' or (cycle_days = 7 and extract(isodow from anchor_date) = 1)),
  constraint shift_patterns_no_overlap exclude using gist (
    employee_id with =, daterange(effective_from, effective_to, '[]') with &&)
);
create index shift_patterns_company_idx on public.shift_patterns (company_id, employee_id);

create table public.shift_pattern_days (
  pattern_id     uuid not null references public.shift_patterns (id) on delete cascade,
  company_id     uuid not null references public.companies (id),
  day_index      integer not null check (day_index between 0 and 55),
  start_time     time not null,
  end_time       time not null,
  break_minutes  integer not null default 0 check (break_minutes between 0 and 240),
  primary key (pattern_id, day_index),
  check (start_time <> end_time)
);

create table public.shift_changes (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null default private.current_company_id() references public.companies (id),
  employee_id    uuid not null,
  work_date      date not null,
  kind           text not null check (kind in ('shift', 'off')),
  start_time     time,
  end_time       time,
  break_minutes  integer not null default 0 check (break_minutes between 0 and 240),
  reason         text not null default '',
  created_by     uuid default auth.uid() references auth.users (id) on delete set null,
  created_at     timestamptz not null default now(),
  foreign key (company_id, employee_id) references public.employees (company_id, id) on delete cascade,
  unique (employee_id, work_date),
  check ((kind = 'off' and start_time is null and end_time is null)
      or (kind = 'shift' and start_time is not null and end_time is not null and start_time <> end_time))
);
create index shift_changes_company_idx on public.shift_changes (company_id, work_date);

create table public.schedule_events (
  id           bigint generated always as identity primary key,
  company_id   uuid not null references public.companies (id),
  employee_id  uuid not null,
  kind         text not null check (kind in ('pattern_set', 'pattern_ended', 'day_set', 'day_cleared')),
  summary      text not null,
  actor        uuid default auth.uid() references auth.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  foreign key (company_id, employee_id) references public.employees (company_id, id) on delete cascade
);
create index schedule_events_company_idx on public.schedule_events (company_id, employee_id, created_at desc);

create table public.assignment_shift_overrides (
  assignment_id  uuid primary key references public.dispatch_assignments (id) on delete cascade,
  company_id     uuid not null references public.companies (id),
  problem        text not null,
  reason         text not null check (length(trim(reason)) between 3 and 500),
  created_by     uuid default auth.uid() references auth.users (id) on delete set null,
  created_at     timestamptz not null default now()
);

alter table public.shift_patterns enable row level security;
alter table public.shift_pattern_days enable row level security;
alter table public.shift_changes enable row level security;
alter table public.schedule_events enable row level security;
alter table public.assignment_shift_overrides enable row level security;
revoke all on public.shift_patterns, public.shift_pattern_days, public.shift_changes, public.schedule_events,
  public.assignment_shift_overrides from anon, authenticated;
grant select on public.shift_patterns, public.shift_pattern_days, public.shift_changes, public.schedule_events,
  public.assignment_shift_overrides to authenticated;

-- Company schedules for people who plan or see staff; one's own schedule for everyone (internal).
create or replace function private.can_see_schedule(p_company uuid, p_employee uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_company = private.current_company_id()
     and (private.has_permission('employees.view') or private.has_permission('dispatch.view')
          or private.has_permission('schedules.manage')
          or exists (select 1 from public.employees e where e.id = p_employee and e.company_id = p_company and e.user_id = auth.uid()));
$$;
revoke all on function private.can_see_schedule(uuid, uuid) from public, anon;
grant execute on function private.can_see_schedule(uuid, uuid) to authenticated; -- used by the read policies

create policy shift_patterns_read on public.shift_patterns for select to authenticated
  using ((select private.can_see_schedule(company_id, employee_id)));
create policy shift_pattern_days_read on public.shift_pattern_days for select to authenticated
  using (exists (select 1 from public.shift_patterns p where p.id = pattern_id and (select private.can_see_schedule(p.company_id, p.employee_id))));
create policy shift_changes_read on public.shift_changes for select to authenticated
  using ((select private.can_see_schedule(company_id, employee_id)));
create policy schedule_events_read on public.schedule_events for select to authenticated
  using ((select private.can_see_schedule(company_id, employee_id)));
create policy assignment_shift_overrides_read on public.assignment_shift_overrides for select to authenticated
  using (company_id = (select private.current_company_id()) and (select private.has_permission('dispatch.view')));

-- "6:00 AM" (internal).
create or replace function private.clock_text(p_time time)
returns text
language sql
immutable
set search_path = ''
as $$
  select ltrim(to_char(p_time, 'HH12:MI AM'), '0');
$$;
revoke all on function private.clock_text(time) from public, anon, authenticated;

-- One person's schedule on one date (internal): status 'shift' (with its start and end in the company's time zone),
-- 'off' (a day off in a pattern, or a day-off change) or 'none' (no pattern and no change). source: 'change' or
-- 'pattern'.
create or replace function private.shift_on(p_company uuid, p_employee uuid, p_date date)
returns table (status text, start_at timestamptz, end_at timestamptz, start_time time, end_time time,
               break_minutes integer, source text, reason text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tz text := private.business_timezone(p_company);
  v_change public.shift_changes%rowtype;
  v_pattern public.shift_patterns%rowtype;
  v_day public.shift_pattern_days%rowtype;
begin
  select * into v_change from public.shift_changes c where c.company_id = p_company and c.employee_id = p_employee and c.work_date = p_date;
  if found then
    if v_change.kind = 'off' then
      return query select 'off'::text, null::timestamptz, null::timestamptz, null::time, null::time, 0, 'change'::text, v_change.reason;
    else
      return query select 'shift'::text,
        (p_date + v_change.start_time) at time zone v_tz,
        (p_date + v_change.end_time + case when v_change.end_time <= v_change.start_time then interval '1 day' else interval '0' end) at time zone v_tz,
        v_change.start_time, v_change.end_time, v_change.break_minutes, 'change'::text, v_change.reason;
    end if;
    return;
  end if;
  select * into v_pattern from public.shift_patterns p
   where p.company_id = p_company and p.employee_id = p_employee
     and p_date >= p.effective_from and (p.effective_to is null or p_date <= p.effective_to);
  if not found then
    return query select 'none'::text, null::timestamptz, null::timestamptz, null::time, null::time, 0, null::text, ''::text;
    return;
  end if;
  select * into v_day from public.shift_pattern_days d
   where d.pattern_id = v_pattern.id and d.day_index = (((p_date - v_pattern.anchor_date) % v_pattern.cycle_days) + v_pattern.cycle_days) % v_pattern.cycle_days;
  if not found then
    return query select 'off'::text, null::timestamptz, null::timestamptz, null::time, null::time, 0, 'pattern'::text, ''::text;
    return;
  end if;
  return query select 'shift'::text,
    (p_date + v_day.start_time) at time zone v_tz,
    (p_date + v_day.end_time + case when v_day.end_time <= v_day.start_time then interval '1 day' else interval '0' end) at time zone v_tz,
    v_day.start_time, v_day.end_time, v_day.break_minutes, 'pattern'::text, ''::text;
end;
$$;
revoke all on function private.shift_on(uuid, uuid, date) from public, anon, authenticated;

-- The schedule of every visible person for a range of days (for the Schedule page, dispatch and My Day).
create or replace function public.schedule_range(p_from date, p_days integer)
returns table (employee_id uuid, full_name text, department text, work_date date, status text,
               start_time time, end_time time, overnight boolean, break_minutes integer, source text, reason text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
begin
  if p_from is null or p_days is null or p_days not between 1 and 42 then
    raise exception 'Choose up to 42 days.' using errcode = '22023';
  end if;
  return query
    select e.id, e.full_name, e.department, d::date, s.status, s.start_time, s.end_time,
           coalesce(s.end_time <= s.start_time, false), s.break_minutes, s.source, s.reason
    from public.employees e
    cross join generate_series(p_from, p_from + (p_days - 1), interval '1 day') d
    cross join lateral private.shift_on(v_company, e.id, d::date) s
    where e.company_id = v_company and e.status in ('active', 'on_leave')
      and private.can_see_schedule(v_company, e.id)
    order by e.full_name, d;
end;
$$;
revoke all on function public.schedule_range(date, integer) from public, anon;
grant execute on function public.schedule_range(date, integer) to authenticated;

-- The employee a schedule change is for, checked against the caller's company (internal).
create or replace function private.schedule_employee(p_employee uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
begin
  perform private.require_permission('schedules.manage');
  if not exists (select 1 from public.employees e where e.id = p_employee and e.company_id = v_company) then
    raise exception 'Person not found.' using errcode = 'P0002';
  end if;
  return v_company;
end;
$$;
revoke all on function private.schedule_employee(uuid) from public, anon, authenticated;

-- Set a weekly pattern or a rotation from a date. p_days: [{"day": 0, "start": "06:00", "end": "16:30", "break": 30}]
-- (day 0 is Monday for a weekly pattern, the anchor date for a rotation). The current pattern ends the day before; a
-- later pattern that has not started yet is replaced.
create or replace function public.schedule_set_pattern(p_employee uuid, p_kind text, p_cycle_days integer, p_anchor date,
                                                      p_effective_from date, p_days jsonb, p_note text default '')
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.schedule_employee(p_employee);
  v_id uuid;
  v_day jsonb;
  v_index integer;
  v_cycle integer := case when p_kind = 'weekly' then 7 else p_cycle_days end;
  v_anchor date := case when p_kind = 'weekly' then p_effective_from - (extract(isodow from p_effective_from)::integer - 1) else p_anchor end;
  v_count integer := 0;
  v_note text := private.clean_text(p_note, 300, 'Note');
begin
  if p_kind not in ('weekly', 'rotation') then raise exception 'Choose weekly or rotation.' using errcode = '22023'; end if;
  if v_cycle is null or v_cycle not between 1 and 56 then raise exception 'A rotation repeats every 1 to 56 days.' using errcode = '22023'; end if;
  if p_effective_from is null or p_effective_from not between date '2000-01-01' and date '2100-12-31' then raise exception 'Choose a valid start date.' using errcode = '22023'; end if;
  if v_anchor is null then raise exception 'Choose the first day of the rotation.' using errcode = '22023'; end if;
  if jsonb_typeof(p_days) <> 'array' or jsonb_array_length(p_days) = 0 then raise exception 'Add at least one working day.' using errcode = '22023'; end if;

  -- Replace patterns that start on or after the new one; end the current one the day before.
  delete from public.shift_patterns p where p.employee_id = p_employee and p.effective_from >= p_effective_from;
  update public.shift_patterns p set effective_to = p_effective_from - 1
   where p.employee_id = p_employee and p.effective_from < p_effective_from and (p.effective_to is null or p.effective_to >= p_effective_from);

  insert into public.shift_patterns (company_id, employee_id, kind, cycle_days, anchor_date, effective_from, note)
  values (v_company, p_employee, p_kind, v_cycle, v_anchor, p_effective_from, v_note)
  returning id into v_id;
  for v_day in select * from jsonb_array_elements(p_days) loop
    v_index := (v_day ->> 'day')::integer;
    if v_index is null or v_index < 0 or v_index >= v_cycle then raise exception 'A shift is outside the pattern.' using errcode = '22023'; end if;
    if (v_day ->> 'start') is null or (v_day ->> 'end') is null or (v_day ->> 'start')::time = (v_day ->> 'end')::time then
      raise exception 'Each shift needs a start and an end time.' using errcode = '22023';
    end if;
    insert into public.shift_pattern_days (pattern_id, company_id, day_index, start_time, end_time, break_minutes)
    values (v_id, v_company, v_index, (v_day ->> 'start')::time, (v_day ->> 'end')::time, coalesce((v_day ->> 'break')::integer, 0));
    v_count := v_count + 1;
  end loop;
  insert into public.schedule_events (company_id, employee_id, kind, summary)
  values (v_company, p_employee, 'pattern_set',
          format('%s from %s: %s working day%s in %s', case when p_kind = 'weekly' then 'Weekly schedule' else format('%s-day rotation', v_cycle) end,
                 to_char(p_effective_from, 'Mon FMDD, YYYY'), v_count, case when v_count = 1 then '' else 's' end,
                 case when p_kind = 'weekly' then 'the week' else 'the cycle' end));
  return v_id;
end;
$$;
revoke all on function public.schedule_set_pattern(uuid, text, integer, date, date, jsonb, text) from public, anon;
grant execute on function public.schedule_set_pattern(uuid, text, integer, date, date, jsonb, text) to authenticated;

-- End a person's pattern after a date (they then have no repeating schedule from the next day).
create or replace function public.schedule_end_pattern(p_employee uuid, p_last_day date)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.schedule_employee(p_employee);
begin
  if p_last_day is null then raise exception 'Choose the last day.' using errcode = '22023'; end if;
  delete from public.shift_patterns p where p.employee_id = p_employee and p.effective_from > p_last_day;
  update public.shift_patterns p set effective_to = p_last_day
   where p.employee_id = p_employee and p.effective_from <= p_last_day and (p.effective_to is null or p.effective_to > p_last_day);
  insert into public.schedule_events (company_id, employee_id, kind, summary)
  values (v_company, p_employee, 'pattern_ended', format('Repeating schedule ends after %s', to_char(p_last_day, 'Mon FMDD, YYYY')));
end;
$$;
revoke all on function public.schedule_end_pattern(uuid, date) from public, anon;
grant execute on function public.schedule_end_pattern(uuid, date) to authenticated;

-- Set one date: a shift (start, end, break) or a day off, replacing the pattern on that date.
create or replace function public.schedule_set_day(p_employee uuid, p_date date, p_kind text, p_start time, p_end time,
                                                  p_break integer default 0, p_reason text default '')
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.schedule_employee(p_employee);
  v_reason text := private.clean_text(p_reason, 300, 'Reason');
begin
  if p_date is null or p_date not between date '2000-01-01' and date '2100-12-31' then raise exception 'Choose a valid date.' using errcode = '22023'; end if;
  if p_kind not in ('shift', 'off') then raise exception 'Choose a shift or a day off.' using errcode = '22023'; end if;
  if p_kind = 'shift' and (p_start is null or p_end is null or p_start = p_end) then
    raise exception 'A shift needs a start and an end time.' using errcode = '22023';
  end if;
  insert into public.shift_changes (company_id, employee_id, work_date, kind, start_time, end_time, break_minutes, reason)
  values (v_company, p_employee, p_date, p_kind,
          case when p_kind = 'shift' then p_start end, case when p_kind = 'shift' then p_end end,
          case when p_kind = 'shift' then coalesce(p_break, 0) else 0 end, v_reason)
  on conflict (employee_id, work_date) do update
    set kind = excluded.kind, start_time = excluded.start_time, end_time = excluded.end_time,
        break_minutes = excluded.break_minutes, reason = excluded.reason, created_by = auth.uid(), created_at = now();
  insert into public.schedule_events (company_id, employee_id, kind, summary)
  values (v_company, p_employee, 'day_set',
          format('%s: %s%s', to_char(p_date, 'Dy Mon FMDD'),
                 case when p_kind = 'off' then 'day off' else private.clock_text(p_start) || '–' || private.clock_text(p_end) end,
                 case when v_reason <> '' then ' (' || v_reason || ')' else '' end));
end;
$$;
revoke all on function public.schedule_set_day(uuid, date, text, time, time, integer, text) from public, anon;
grant execute on function public.schedule_set_day(uuid, date, text, time, time, integer, text) to authenticated;

-- Remove a one-day change (the pattern applies again on that date).
create or replace function public.schedule_clear_day(p_employee uuid, p_date date)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.schedule_employee(p_employee);
begin
  delete from public.shift_changes c where c.employee_id = p_employee and c.work_date = p_date;
  if found then
    insert into public.schedule_events (company_id, employee_id, kind, summary)
    values (v_company, p_employee, 'day_cleared', format('%s: back to the regular schedule', to_char(p_date, 'Dy Mon FMDD')));
  end if;
end;
$$;
revoke all on function public.schedule_clear_day(uuid, date) from public, anon;
grant execute on function public.schedule_clear_day(uuid, date) to authenticated;

-- Why a driver is not on shift for a load, or null (internal). Not checked when the driver has no linked person or the
-- person has no schedule on those days. A load with times must fit inside one shift (the day before's overnight shift
-- counts); a load with only a date needs a shift that day.
create or replace function private.driver_shift_problem(p_company uuid, p_driver uuid, p_load uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_employee uuid;
  v_load public.order_loads%rowtype;
  v_today record;
  v_before record;
  v_start timestamptz;
  v_end timestamptz;
begin
  select e.id into v_employee from public.employees e where e.company_id = p_company and e.driver_id = p_driver limit 1;
  if v_employee is null then return null; end if;
  select * into v_load from public.order_loads l where l.id = p_load;
  if not found or v_load.load_date is null then return null; end if;
  select * into v_today from private.shift_on(p_company, v_employee, v_load.load_date);
  select * into v_before from private.shift_on(p_company, v_employee, v_load.load_date - 1);
  if v_today.status = 'none' and v_before.status = 'none' then return null; end if;
  if v_load.starts_at is null then
    if v_today.status = 'shift' then return null; end if;
    return case when v_today.status = 'off' then 'Day off on ' || to_char(v_load.load_date, 'Dy Mon FMDD') else 'No shift on ' || to_char(v_load.load_date, 'Dy Mon FMDD') end;
  end if;
  v_start := v_load.starts_at;
  v_end := coalesce(v_load.ends_at, v_load.starts_at);
  if v_today.status = 'shift' and v_start >= v_today.start_at and v_end <= v_today.end_at then return null; end if;
  if v_before.status = 'shift' and v_before.end_time <= v_before.start_time and v_start >= v_before.start_at and v_end <= v_before.end_at then return null; end if;
  if v_today.status = 'shift' then
    return 'Not on shift: works ' || private.clock_text(v_today.start_time) || '–' || private.clock_text(v_today.end_time)
           || ' on ' || to_char(v_load.load_date, 'Dy Mon FMDD');
  end if;
  return 'Day off on ' || to_char(v_load.load_date, 'Dy Mon FMDD');
end;
$$;
revoke all on function private.driver_shift_problem(uuid, uuid, uuid) from public, anon, authenticated;

-- New active assignments: a driver scheduled off needs a reason (set for this transaction by
-- public.assign_load_off_shift). The reason and the problem are recorded with the assignment.
create or replace function private.dispatch_shift_check()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_problem text;
  v_reason text := nullif(trim(coalesce(current_setting('taviron.off_shift_reason', true), '')), '');
begin
  if new.status <> 'active' or new.driver_id is null then return new; end if;
  v_problem := private.driver_shift_problem(new.company_id, new.driver_id, new.load_id);
  if v_problem is null then return new; end if;
  if v_reason is null then
    raise exception '%', v_problem using errcode = 'P0001', hint = 'off_shift';
  end if;
  new.warnings := array_append(coalesce(new.warnings, '{}'), 'driver_off_shift');
  return new;
end;
$$;
revoke all on function private.dispatch_shift_check() from public, anon, authenticated;
create trigger dispatch_assignments_shift_check before insert on public.dispatch_assignments
  for each row execute function private.dispatch_shift_check();

create or replace function private.dispatch_shift_record()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reason text := nullif(trim(coalesce(current_setting('taviron.off_shift_reason', true), '')), '');
begin
  if 'driver_off_shift' = any (new.warnings) and v_reason is not null then
    insert into public.assignment_shift_overrides (assignment_id, company_id, problem, reason)
    values (new.id, new.company_id, coalesce(private.driver_shift_problem(new.company_id, new.driver_id, new.load_id), 'Not on shift'), left(v_reason, 500));
  end if;
  return new;
end;
$$;
revoke all on function private.dispatch_shift_record() from public, anon, authenticated;
create trigger dispatch_assignments_shift_record after insert on public.dispatch_assignments
  for each row execute function private.dispatch_shift_record();

-- Assign outside the driver's shift with a reason: the same assign_load, permission and checks, with the reason
-- recorded. The reason applies to this call only.
create or replace function public.assign_load_off_shift(p_load_id uuid, p_truck_id uuid, p_trailer_id uuid, p_driver_id uuid,
                                                       p_note text, p_replace_assignment_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
  v_reason text := trim(coalesce(p_reason, ''));
begin
  perform private.require_permission('dispatch.edit');
  if length(v_reason) < 3 then raise exception 'Say why the driver works outside their shift.' using errcode = '22023'; end if;
  perform set_config('taviron.off_shift_reason', left(v_reason, 500), true);
  v_result := public.assign_load(p_load_id, p_truck_id, p_trailer_id, p_driver_id, coalesce(p_note, ''), p_replace_assignment_id);
  perform set_config('taviron.off_shift_reason', '', true);
  -- Report the warnings as stored (the shift check adds driver_off_shift to the assignment itself).
  return jsonb_set(v_result, '{warnings}', to_jsonb((select a.warnings from public.dispatch_assignments a where a.id = (v_result ->> 'assignment_id')::uuid)));
end;
$$;
revoke all on function public.assign_load_off_shift(uuid, uuid, uuid, uuid, text, uuid, text) from public, anon;
grant execute on function public.assign_load_off_shift(uuid, uuid, uuid, uuid, text, uuid, text) to authenticated;
