-- Work schedules for PTO (owner requirement 2026-10-13: full-day requests use scheduled hours).
--
-- Each employee may have a weekly schedule: hours per weekday (0–24). A full-day time-off request then counts the
-- scheduled hours of the days it covers, instead of asking the employee to type them. Only someone with
-- time_off.approve may enter different hours (a correction); an employee cannot under-count their own request.
-- Without a schedule nothing changes: the hours are entered as before. Partial days keep using start and end times.

create table public.employee_work_schedules (
  employee_id  uuid primary key,
  company_id   uuid not null default private.current_company_id() references public.companies (id),
  mon_hours    numeric(4, 2) not null default 0 check (mon_hours between 0 and 24),
  tue_hours    numeric(4, 2) not null default 0 check (tue_hours between 0 and 24),
  wed_hours    numeric(4, 2) not null default 0 check (wed_hours between 0 and 24),
  thu_hours    numeric(4, 2) not null default 0 check (thu_hours between 0 and 24),
  fri_hours    numeric(4, 2) not null default 0 check (fri_hours between 0 and 24),
  sat_hours    numeric(4, 2) not null default 0 check (sat_hours between 0 and 24),
  sun_hours    numeric(4, 2) not null default 0 check (sun_hours between 0 and 24),
  updated_by   uuid default auth.uid() references auth.users (id) on delete set null,
  updated_at   timestamptz not null default now(),
  foreign key (company_id, employee_id) references public.employees (company_id, id) on delete cascade
);
alter table public.employee_work_schedules enable row level security;
revoke all on public.employee_work_schedules from anon;
grant select, insert, update, delete on public.employee_work_schedules to authenticated;

-- Readable by people who see employees or decide time off, and by the employee themself; changed with employees.edit.
create policy employee_work_schedules_read on public.employee_work_schedules for select to authenticated
  using (company_id = (select private.current_company_id())
         and ((select private.has_permission('employees.view')) or (select private.has_permission('time_off.approve'))
              or exists (select 1 from public.employees e where e.id = employee_work_schedules.employee_id and e.company_id = employee_work_schedules.company_id and e.user_id = (select auth.uid()))));
create policy employee_work_schedules_insert on public.employee_work_schedules for insert to authenticated
  with check (company_id = (select private.current_company_id()) and (select private.has_permission('employees.edit')));
create policy employee_work_schedules_update on public.employee_work_schedules for update to authenticated
  using (company_id = (select private.current_company_id()) and (select private.has_permission('employees.edit')))
  with check (company_id = (select private.current_company_id()) and (select private.has_permission('employees.edit')));
create policy employee_work_schedules_delete on public.employee_work_schedules for delete to authenticated
  using (company_id = (select private.current_company_id()) and (select private.has_permission('employees.edit')));

-- Scheduled hours between two dates (inclusive); null when the employee has no schedule (internal).
create or replace function private.scheduled_hours(p_company uuid, p_employee uuid, p_start date, p_end date)
returns numeric
language sql
stable
set search_path = ''
as $$
  select sum(case extract(isodow from d)::int
               when 1 then w.mon_hours when 2 then w.tue_hours when 3 then w.wed_hours when 4 then w.thu_hours
               when 5 then w.fri_hours when 6 then w.sat_hours else w.sun_hours end)
  from public.employee_work_schedules w
  cross join generate_series(p_start, p_end, interval '1 day') d
  where w.company_id = p_company and w.employee_id = p_employee
  group by w.employee_id
$$;
revoke all on function private.scheduled_hours(uuid, uuid, date, date) from public, anon, authenticated;

CREATE OR REPLACE FUNCTION public.time_off_save(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_company  uuid := private.require_company();
  v_id       uuid := nullif(p ->> 'id', '')::uuid;
  v_key      uuid := nullif(p ->> 'submission_key', '')::uuid;
  v_emp      public.employees%rowtype;
  v_req      public.time_off_requests%rowtype;
  v_full     boolean := coalesce((p ->> 'full_day')::boolean, true);
  v_start    date := nullif(p ->> 'start_date', '')::date;
  v_end      date := coalesce(nullif(p ->> 'end_date', '')::date, nullif(p ->> 'start_date', '')::date);
  v_st       time := case when v_full then null else nullif(p ->> 'start_time', '')::time end;
  v_et       time := case when v_full then null else nullif(p ->> 'end_time', '')::time end;
  v_hours    numeric;
  v_other    text;
  v_category text;
  v_bank     public.pto_banks%rowtype;
  v_balance  numeric;
  v_pending  numeric;
  v_scheduled numeric;
begin
  if v_key is not null and v_id is null then
    select * into v_req from public.time_off_requests where company_id = v_company and submission_key = v_key;
    if found then
      return jsonb_build_object('id', v_req.id, 'duplicate', true);
    end if;
  end if;

  if v_id is not null then
    select * into v_req from public.time_off_requests where id = v_id and company_id = v_company for update;
    if not found then raise exception 'Request not found.' using errcode = 'P0002'; end if;
    if v_req.status <> 'pending' then raise exception 'Only a pending request can be changed.' using errcode = 'P0001'; end if;
    if (p ->> 'expected_seq') is not null and (p ->> 'expected_seq')::integer <> v_req.edit_seq then
      raise exception 'This request was changed by someone else. Reload to see the latest version.' using errcode = 'PT409';
    end if;
    select * into v_emp from public.employees where id = v_req.employee_id and company_id = v_company for update;
  elsif nullif(p ->> 'employee_id', '') is null then
    select * into v_emp from public.employees where company_id = v_company and user_id = auth.uid() for update;
    if not found then
      raise exception 'Your login is not linked to an employee record. Ask the office to link it.' using errcode = 'P0002';
    end if;
  else
    select * into v_emp from public.employees where id = (p ->> 'employee_id')::uuid and company_id = v_company for update;
    if not found then raise exception 'Employee not found.' using errcode = 'P0002'; end if;
  end if;

  if v_emp.user_id is distinct from auth.uid() then
    perform private.require_permission('time_off.approve');
  end if;
  if v_emp.status not in ('active', 'on_leave') then
    raise exception 'Time off can only be requested for current employees.' using errcode = 'P0001';
  end if;
  if v_start is null then raise exception 'Enter the first day.' using errcode = 'P0001'; end if;
  if v_end < v_start then raise exception 'The last day is before the first day.' using errcode = 'P0001'; end if;
  if v_end - v_start > 366 then raise exception 'A request can cover at most a year.' using errcode = 'P0001'; end if;
  if not v_full then
    if v_end <> v_start then raise exception 'A partial day covers a single date.' using errcode = 'P0001'; end if;
    if v_st is null or v_et is null or v_et <= v_st then
      raise exception 'Enter the start and end time of the partial day (end after start).' using errcode = 'P0001';
    end if;
    v_hours := round(extract(epoch from (v_et - v_st)) / 3600.0, 2);
  else
    -- Full days use the employee's work schedule (20261114000300) when one is recorded; only someone who approves
    -- time off may enter different hours (a correction). Without a schedule the hours are entered, as before.
    v_scheduled := private.scheduled_hours(v_company, v_emp.id, v_start, v_end);
    v_hours := nullif(p ->> 'hours', '')::numeric;
    if v_scheduled is not null and (v_hours is null or not private.has_permission('time_off.approve')) then
      v_hours := v_scheduled;
    end if;
    if v_scheduled is not null and v_hours = 0 then
      raise exception 'These days have no scheduled hours in the work schedule. Choose working days, or ask the office to update the schedule.'
        using errcode = 'P0001';
    end if;
  end if;

  -- A category that draws from a PTO bank (20261112000100): the employee must be eligible (employment type, waiting
  -- period from the hire date), the hours must be known, and they must fit the available balance (balance minus the
  -- employee's other pending requests on that bank). The employee row is locked above, so two requests of the same
  -- person cannot both pass against the same hours.
  v_category := coalesce(nullif(p ->> 'category', ''), v_req.category, 'vacation');
  select * into v_bank from public.pto_banks b
  where b.company_id = v_company and b.active and v_category = any (b.categories);
  if found then
    if not (v_emp.employment_type = any (v_bank.employment_types)) then
      raise exception '% is not available to % employees. Choose another kind of time off.', v_bank.name, replace(v_emp.employment_type, '_', '-')
        using errcode = 'P0001';
    end if;
    if v_bank.waiting_days > 0 then
      if v_emp.hire_date is null then
        raise exception '% has a waiting period of % days from the hire date, and no hire date is recorded. Ask the office to record it.', v_bank.name, v_bank.waiting_days
          using errcode = 'P0001';
      elsif v_start < v_emp.hire_date + v_bank.waiting_days then
        raise exception '% can be used from % (% days after the hire date).', v_bank.name, to_char(v_emp.hire_date + v_bank.waiting_days, 'Mon FMDD, YYYY'), v_bank.waiting_days
          using errcode = 'P0001';
      end if;
    end if;
    if v_hours is null then
      raise exception 'Enter how many hours of % this request uses.', v_bank.name using errcode = 'P0001';
    end if;
    v_balance := private.pto_balance(v_company, v_emp.id, v_bank.id);
    v_pending := private.pto_pending(v_company, v_emp.id, v_bank.id, v_id);
    if v_hours > v_balance - v_pending then
      raise exception 'This request uses % h of %, but only % h are available (balance % h, other pending requests % h).',
        trim_scale(v_hours), v_bank.name, trim_scale(greatest(v_balance - v_pending, 0)), trim_scale(v_balance), trim_scale(v_pending) using errcode = 'P0001';
    end if;
  end if;

  -- One employee's pending/approved requests never overlap (no double counting).
  select to_char(t.start_date, 'Mon FMDD') || case when t.end_date <> t.start_date then '–' || to_char(t.end_date, 'Mon FMDD') else '' end
    into v_other
  from public.time_off_requests t
  where t.company_id = v_company and t.employee_id = v_emp.id and t.status in ('pending', 'approved')
    and t.id is distinct from v_id
    and daterange(t.start_date, t.end_date, '[]') && daterange(v_start, v_end, '[]')
    and (t.full_day or v_full or tsrange(t.start_date + t.start_time, t.start_date + t.end_time) && tsrange(v_start + v_st, v_start + v_et))
  limit 1;
  if v_other is not null then
    raise exception 'This overlaps another request (%). Cancel or change that one first.', v_other using errcode = 'P0001';
  end if;

  if v_id is null then
    insert into public.time_off_requests (company_id, employee_id, category, start_date, end_date, full_day, start_time, end_time,
                                          hours, reason, submitted_by, submission_key, pto_bank_id)
    values (v_company, v_emp.id, v_category, v_start, v_end, v_full, v_st, v_et,
            v_hours, private.clean_text(p ->> 'reason', 1000, 'Reason'), auth.uid(), v_key, v_bank.id)
    returning id into v_id;
    perform private.time_off_event(v_company, v_id, 'submitted', '');
  else
    update public.time_off_requests set
      category = v_category, pto_bank_id = v_bank.id, start_date = v_start, end_date = v_end, full_day = v_full,
      start_time = v_st, end_time = v_et, hours = v_hours, reason = private.clean_text(p ->> 'reason', 1000, 'Reason'),
      edit_seq = edit_seq + 1, updated_at = now()
    where id = v_id;
    perform private.time_off_event(v_company, v_id, 'updated', '');
  end if;
  return jsonb_build_object('id', v_id, 'duplicate', false);
exception
  when unique_violation then
    select * into v_req from public.time_off_requests where company_id = v_company and submission_key = v_key;
    if found then return jsonb_build_object('id', v_req.id, 'duplicate', true); end if;
    raise;
end;
$function$

;
