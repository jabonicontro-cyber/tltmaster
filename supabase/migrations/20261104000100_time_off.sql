-- =============================================================================
-- Driver time off: requests, approval, history, and approved absences feeding
-- dispatch eligibility.
--
-- * public.time_off_requests — one request per employee and period: category,
--   start/end dates, full day or a partial day with start/end times (hours are
--   derived), reason, status pending → approved | denied | canceled.
--   Employees request their own time off; people with time_off.approve may
--   enter it for anyone (drivers often have no login) and decide requests.
--   Nobody decides their own request. Requests of one employee may not overlap
--   another pending or approved request (no double counting).
-- * public.time_off_events — append-only history (who, when, what, note).
-- * Dispatch: approved leave blocks the driver at the moment of assignment
--   (private.check_assignment → private.driver_time_off_conflict, using the
--   load's exact times for partial days). A full-day approved absence is also a
--   blocker in private.assignment_eligibility, so the Command Center flags
--   existing assignments that now collide; a partial day or a pending request
--   there is a warning. Approving leave never cancels or moves assignments: the
--   decision returns the conflicting assignments for review.
-- * public.dispatch_time_off(from, to) — absences for dispatch (dispatch.view):
--   dates, times and status only, never the category or reason.
--
-- Not included (honest limits): balances, accruals, policies, carryover; work
-- schedules (a full day is the whole calendar day in the company time zone);
-- manager hierarchies (approval is company-wide with time_off.approve).
--
-- Permissions: time_off.view (all requests), time_off.approve (decide, enter
-- for others). Defaults: owner both; office view; dispatcher view.
-- Replaces private.assignment_eligibility and private.eligibility_message
-- (bodies from 20261103000100 plus the time-off block) and private.check_assignment
-- (body from 20261014000100 plus the time-off check).
-- Depends on 20261031000100 (employees) and 20261103000100 (dispatch).
-- Rollback: supabase/rollbacks/20261104000100_time_off.down.sql
-- =============================================================================

insert into public.permissions (code, category, description) values
  ('time_off.view',    'Employees', 'See everyone''s time-off requests'),
  ('time_off.approve', 'Employees', 'Approve or deny time off, and enter it for employees');
insert into public.role_permission_defaults (role, permission) values
  ('owner', 'time_off.view'), ('owner', 'time_off.approve'),
  ('office', 'time_off.view'), ('dispatcher', 'time_off.view');
insert into public.role_permissions (company_id, role, permission)
select c.id, d.role, d.permission
from public.companies c cross join public.role_permission_defaults d
where d.permission like 'time_off.%'
on conflict do nothing;

create table public.time_off_requests (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies (id),
  employee_id     uuid not null,
  category        text not null check (category in ('vacation', 'sick', 'personal', 'bereavement', 'jury_duty', 'unpaid', 'other')),
  start_date      date not null,
  end_date        date not null,
  full_day        boolean not null default true,
  start_time      time,
  end_time        time,
  hours           numeric(6, 2),
  reason          text not null default '' check (length(reason) <= 1000),
  status          text not null default 'pending' check (status in ('pending', 'approved', 'denied', 'canceled')),
  submitted_by    uuid references auth.users (id) on delete set null,
  decided_by      uuid references auth.users (id) on delete set null,
  decided_at      timestamptz,
  decision_note   text not null default '' check (length(decision_note) <= 1000),
  submission_key  uuid,
  edit_seq        integer not null default 1,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (company_id, id),
  foreign key (company_id, employee_id) references public.employees (company_id, id),
  constraint time_off_dates check (end_date >= start_date and end_date - start_date <= 366),
  constraint time_off_partial check (
    (full_day and start_time is null and end_time is null)
    or (not full_day and start_date = end_date and start_time is not null and end_time is not null and end_time > start_time)),
  constraint time_off_hours check (hours is null or (hours > 0 and hours <= 24 * 367))
);
create unique index time_off_submission_key on public.time_off_requests (company_id, submission_key) where submission_key is not null;
create index time_off_employee_idx on public.time_off_requests (company_id, employee_id, start_date);
create index time_off_period_idx on public.time_off_requests (company_id, start_date, end_date) where status in ('pending', 'approved');

create table public.time_off_events (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies (id),
  request_id  uuid not null,
  kind        text not null check (kind in ('submitted', 'updated', 'approved', 'denied', 'canceled')),
  note        text not null default '' check (length(note) <= 1000),
  details     jsonb not null default '{}'::jsonb,
  actor_id    uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default clock_timestamp(),
  foreign key (company_id, request_id) references public.time_off_requests (company_id, id) on delete cascade
);
create index time_off_events_request_idx on public.time_off_events (company_id, request_id, created_at);

create trigger a_company_guard before update of company_id on public.time_off_requests
  for each row execute function private.forbid_company_change();
create trigger a_company_guard before update of company_id on public.time_off_events
  for each row execute function private.forbid_company_change();
create trigger time_off_requests_audit after insert or update or delete on public.time_off_requests
  for each row execute function private.audit_row_change('time_off_request');

alter table public.time_off_requests enable row level security;
alter table public.time_off_events enable row level security;

-- Own requests (through the employee record linked to the login), or everyone's with time_off.view.
create or replace function private.is_own_employee(p_employee_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.employees e
                 where e.id = p_employee_id and e.company_id = private.current_company_id() and e.user_id = auth.uid())
$$;

create policy time_off_requests_read on public.time_off_requests for select to authenticated
  using (company_id = (select private.current_company_id())
         and ((select private.has_permission('time_off.view')) or private.is_own_employee(employee_id)));
create policy time_off_events_read on public.time_off_events for select to authenticated
  using (company_id = (select private.current_company_id())
         and ((select private.has_permission('time_off.view'))
              or exists (select 1 from public.time_off_requests r where r.id = request_id and private.is_own_employee(r.employee_id))));

revoke all on public.time_off_requests, public.time_off_events from anon, authenticated;
grant select on public.time_off_requests, public.time_off_events to authenticated;
grant all on public.time_off_requests, public.time_off_events to service_role;

create or replace function private.time_off_event(p_company uuid, p_request uuid, p_kind text, p_note text, p_details jsonb default '{}'::jsonb)
returns void
language sql
set search_path = ''
as $$
  insert into public.time_off_events (company_id, request_id, kind, note, details, actor_id)
  values (p_company, p_request, p_kind, coalesce(p_note, ''), coalesce(p_details, '{}'::jsonb), auth.uid());
$$;

-- The window an approved request covers, as timestamps in the company's time zone.
create or replace function private.time_off_window(p_company uuid, r public.time_off_requests)
returns tstzrange
language sql
stable
set search_path = ''
as $$
  select case when r.full_day
    then tstzrange((r.start_date::timestamp) at time zone private.business_timezone(p_company),
                   ((r.end_date + 1)::timestamp) at time zone private.business_timezone(p_company), '[)')
    else tstzrange((r.start_date + r.start_time) at time zone private.business_timezone(p_company),
                   (r.start_date + r.end_time) at time zone private.business_timezone(p_company), '[)')
  end
$$;

/** Message when the driver has approved time off overlapping the given times, else null. */
create or replace function private.driver_time_off_conflict(p_company uuid, p_driver_id uuid, p_starts timestamptz, p_ends timestamptz)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  r public.time_off_requests%rowtype;
begin
  select t.* into r
  from public.time_off_requests t
  join public.employees e on e.company_id = t.company_id and e.id = t.employee_id
  where t.company_id = p_company and e.driver_id = p_driver_id and t.status = 'approved'
    and private.time_off_window(p_company, t) && tstzrange(p_starts, p_ends, '[)')
  order by t.start_date
  limit 1;
  if not found then
    return null;
  end if;
  return case when r.full_day
    then format('The driver has approved time off from %s to %s.', to_char(r.start_date, 'Mon FMDD'), to_char(r.end_date, 'Mon FMDD, YYYY'))
    else format('The driver has approved time off on %s from %s to %s, which overlaps this load.', to_char(r.start_date, 'Mon FMDD, YYYY'),
                to_char(r.start_time, 'FMHH12:MI AM'), to_char(r.end_time, 'FMHH12:MI AM'))
  end;
end;
$$;

-- Active assignments of the employee's driver record that overlap a request's window.
create or replace function private.time_off_assignment_conflicts(p_company uuid, p_request uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('assignment_id', a.id, 'load_id', a.load_id, 'order_number', o.order_number,
                                               'load_number', l.load_number, 'load_date', l.load_date, 'starts_at', a.starts_at, 'ends_at', a.ends_at)
                            order by a.starts_at), '[]'::jsonb)
  from public.time_off_requests t
  join public.employees e on e.company_id = t.company_id and e.id = t.employee_id
  join public.dispatch_assignments a on a.company_id = t.company_id and a.driver_id = e.driver_id and a.status = 'active'
  join public.order_loads l on l.company_id = a.company_id and l.id = a.load_id
  join public.orders o on o.company_id = l.company_id and o.id = l.order_id
  where t.company_id = p_company and t.id = p_request
    and private.time_off_window(p_company, t) && tstzrange(a.starts_at, a.ends_at, '[)')
$$;

/**
 * Submit (or, with p.id, edit a pending) request.
 * p: { id?, employee_id?, category, start_date, end_date, full_day, start_time?, end_time?, hours?, reason?, submission_key?, expected_seq? }
 * Without employee_id: the caller's own employee record. For someone else: time_off.approve.
 */
create or replace function public.time_off_save(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
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
    v_hours := nullif(p ->> 'hours', '')::numeric;
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
                                          hours, reason, submitted_by, submission_key)
    values (v_company, v_emp.id, coalesce(nullif(p ->> 'category', ''), 'vacation'), v_start, v_end, v_full, v_st, v_et,
            v_hours, private.clean_text(p ->> 'reason', 1000, 'Reason'), auth.uid(), v_key)
    returning id into v_id;
    perform private.time_off_event(v_company, v_id, 'submitted', '');
  else
    update public.time_off_requests set
      category = coalesce(nullif(p ->> 'category', ''), category), start_date = v_start, end_date = v_end, full_day = v_full,
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
$$;

/** Approve or deny a pending request (time_off.approve; never one's own). Returns conflicting assignments for review. */
create or replace function public.time_off_decide(p_id uuid, p_decision text, p_note text default '')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company   uuid := private.require_company();
  v_req       public.time_off_requests%rowtype;
  v_owner     uuid;
  v_conflicts jsonb := '[]'::jsonb;
begin
  perform private.require_permission('time_off.approve');
  if p_decision not in ('approved', 'denied') then raise exception 'Choose approve or deny.'; end if;
  select * into v_req from public.time_off_requests where id = p_id and company_id = v_company for update;
  if not found then raise exception 'Request not found.' using errcode = 'P0002'; end if;
  select user_id into v_owner from public.employees where id = v_req.employee_id;
  if v_owner = auth.uid() then
    raise exception 'You cannot decide your own time-off request. Another approver must decide it.' using errcode = '42501';
  end if;
  if v_req.status <> 'pending' then
    raise exception 'This request is already %.', v_req.status using errcode = 'P0001';
  end if;
  update public.time_off_requests set status = p_decision, decided_by = auth.uid(), decided_at = now(),
    decision_note = private.clean_text(p_note, 1000, 'Note'), edit_seq = edit_seq + 1, updated_at = now()
  where id = p_id;
  if p_decision = 'approved' then
    v_conflicts := private.time_off_assignment_conflicts(v_company, p_id);
  end if;
  perform private.time_off_event(v_company, p_id, p_decision, p_note, jsonb_build_object('conflicting_assignments', v_conflicts));
  return jsonb_build_object('status', p_decision, 'conflicts', v_conflicts);
end;
$$;

/** Cancel a pending request (requester or approver) or an approved one (approver; or the employee before it starts). */
create or replace function public.time_off_cancel(p_id uuid, p_note text default '')
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v_req     public.time_off_requests%rowtype;
  v_owner   uuid;
  v_own     boolean;
begin
  select * into v_req from public.time_off_requests where id = p_id and company_id = v_company for update;
  if not found then raise exception 'Request not found.' using errcode = 'P0002'; end if;
  select user_id into v_owner from public.employees where id = v_req.employee_id;
  v_own := v_owner is not distinct from auth.uid() and v_owner is not null;
  if v_req.status not in ('pending', 'approved') then
    raise exception 'This request is already %.', v_req.status using errcode = 'P0001';
  end if;
  if not private.has_permission('time_off.approve') then
    if not v_own then
      raise exception 'You do not have permission to cancel this request.' using errcode = '42501';
    end if;
    if v_req.status = 'approved' and v_req.start_date <= private.business_today(v_company) then
      raise exception 'Approved time off that has started can only be canceled by an approver.' using errcode = '42501';
    end if;
  end if;
  update public.time_off_requests set status = 'canceled', edit_seq = edit_seq + 1, updated_at = now() where id = p_id;
  perform private.time_off_event(v_company, p_id, 'canceled', p_note, jsonb_build_object('was', v_req.status));
end;
$$;

/** Absences for dispatch (dispatch.view): driver, dates, times, status — never the category or reason. */
create or replace function public.dispatch_time_off(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
begin
  perform private.require_permission('dispatch.view');
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 62 then
    raise exception 'Choose a date range of at most 62 days.';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('driver_id', e.driver_id, 'status', t.status, 'start_date', t.start_date, 'end_date', t.end_date,
                                        'full_day', t.full_day, 'start_time', t.start_time, 'end_time', t.end_time,
                                        'starts_at', lower(private.time_off_window(v_company, t)), 'ends_at', upper(private.time_off_window(v_company, t)))
                     order by t.start_date)
    from public.time_off_requests t
    join public.employees e on e.company_id = t.company_id and e.id = t.employee_id
    where t.company_id = v_company and e.driver_id is not null and t.status in ('pending', 'approved')
      and t.start_date <= p_to and t.end_date >= p_from
  ), '[]'::jsonb);
end;
$$;

revoke execute on function public.time_off_save(jsonb), public.time_off_decide(uuid, text, text),
  public.time_off_cancel(uuid, text), public.dispatch_time_off(date, date) from public, anon;
grant execute on function public.time_off_save(jsonb), public.time_off_decide(uuid, text, text),
  public.time_off_cancel(uuid, text), public.dispatch_time_off(date, date) to authenticated;
revoke execute on function private.driver_time_off_conflict(uuid, uuid, timestamptz, timestamptz),
  private.time_off_assignment_conflicts(uuid, uuid) from public, anon, authenticated;

CREATE OR REPLACE FUNCTION private.eligibility_message(p_code text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  select case p_code
    when 'truck_inactive' then 'Truck is deactivated.'
    when 'truck_out_of_service' then 'Truck is out of service.'
    when 'truck_capacity_unknown' then 'Truck capacity is not recorded.'
    when 'truck_capacity_unverified' then 'Truck capacity is recorded but not verified.'
    when 'trailer_inactive' then 'Trailer is deactivated.'
    when 'trailer_out_of_service' then 'Trailer is out of service.'
    when 'trailer_capacity_unknown' then 'Trailer capacity is not recorded.'
    when 'trailer_capacity_unverified' then 'Trailer capacity is recorded but not verified.'
    when 'trailer_incompatible' then 'This trailer is not recorded as compatible with this truck type.'
    when 'trailer_compatibility_unknown' then 'Trailer compatibility is not recorded.'
    when 'trailer_required' then 'A tractor needs a trailer for this load.'
    when 'driver_inactive' then 'Driver is inactive.'
    when 'cdl_missing' then 'No CDL is recorded for this driver.'
    when 'cdl_class_insufficient' then 'Driver''s CDL class is not high enough for this combination.'
    when 'cdl_expired' then 'Driver''s CDL has expired.'
    when 'cdl_expiry_unknown' then 'Driver''s CDL expiry date is not recorded.'
    when 'cdl_unverified' then 'Driver''s CDL has not been verified.'
    when 'cdl_expiring_soon' then 'Driver''s CDL expires within 30 days.'
    when 'medical_card_missing' then 'No DOT medical card is recorded for this driver.'
    when 'medical_card_class_insufficient' then 'Medical card does not qualify.'
    when 'medical_card_expired' then 'Driver''s medical card has expired.'
    when 'medical_card_expiry_unknown' then 'Driver''s medical card expiry date is not recorded.'
    when 'medical_card_unverified' then 'Driver''s medical card has not been verified.'
    when 'medical_card_expiring_soon' then 'Driver''s medical card expires within 30 days.'
    when 'truck_safety_report_open' then 'A driver reported a breakdown or inspection problem on this truck that is not resolved yet.'
    when 'trailer_safety_report_open' then 'A driver reported a breakdown or inspection problem on this trailer that is not resolved yet.'
    when 'truck_equipment_report_open' then 'A driver reported an equipment issue on this truck that is not resolved yet.'
    when 'trailer_equipment_report_open' then 'A driver reported an equipment issue on this trailer that is not resolved yet.'
    when 'truck_safety_restricted' then 'Truck has an open safety-critical work order. It returns to service only after an authorized inspection clears it.'
    when 'truck_shop_scheduled' then 'Truck is scheduled in the shop on this date.'
    when 'truck_shop_work_open' then 'Truck has shop work in progress or waiting for parts — check with the shop.'
    when 'driver_time_off' then 'Driver has approved time off on this date.'
    when 'driver_partial_time_off' then 'Driver has approved partial-day time off on this date — check the load times.'
    when 'driver_time_off_pending' then 'Driver has a pending time-off request on this date.'
    else p_code
  end
$function$;

CREATE OR REPLACE FUNCTION private.assignment_eligibility(p_company uuid, p_truck_id uuid, p_trailer_id uuid, p_driver_id uuid, p_on date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_company  uuid;
  v_on       date;
  v_truck    public.trucks%rowtype;
  v_trailer  public.trailers%rowtype;
  v_driver   public.drivers%rowtype;
  v_blockers text[] := '{}';
  v_warnings text[] := '{}';
  v_state    text;
  v_min      public.cdl_class;
  v_soon     date;
begin
  v_company := p_company;
  v_on := coalesce(p_on, private.business_today(v_company));
  v_soon := v_on + 30;

  if p_truck_id is null and p_trailer_id is null and p_driver_id is null then
    raise exception 'Choose a truck, a trailer or a driver.';
  end if;

  if p_truck_id is not null then
    select * into v_truck from public.trucks where id = p_truck_id and company_id = v_company;
    if not found then raise exception 'Truck not found.'; end if;
    if not v_truck.active then v_blockers := v_blockers || 'truck_inactive'::text; end if;
    if v_truck.service_status = 'out_of_service' then v_blockers := v_blockers || 'truck_out_of_service'::text; end if;
    if v_truck.weight_capacity is null and v_truck.volume_capacity is null then
      v_warnings := v_warnings || 'truck_capacity_unknown'::text;
    elsif v_truck.capacity_verified_at is null then
      v_warnings := v_warnings || 'truck_capacity_unverified'::text;
    end if;
  end if;

  if p_trailer_id is not null then
    select * into v_trailer from public.trailers where id = p_trailer_id and company_id = v_company;
    if not found then raise exception 'Trailer not found.'; end if;
    if not v_trailer.active then v_blockers := v_blockers || 'trailer_inactive'::text; end if;
    if v_trailer.service_status = 'out_of_service' then v_blockers := v_blockers || 'trailer_out_of_service'::text; end if;
    if v_trailer.weight_capacity is null and v_trailer.volume_capacity is null then
      v_warnings := v_warnings || 'trailer_capacity_unknown'::text;
    elsif v_trailer.capacity_verified_at is null then
      v_warnings := v_warnings || 'trailer_capacity_unverified'::text;
    end if;
    if p_truck_id is not null then
      if cardinality(v_trailer.compatible_truck_types) = 0 then
        v_warnings := v_warnings || 'trailer_compatibility_unknown'::text;
      elsif not (v_truck.truck_type = any (v_trailer.compatible_truck_types)) then
        v_blockers := v_blockers || 'trailer_incompatible'::text;
      end if;
    end if;
  end if;

  -- Unresolved driver reports about the equipment (N15).
  if p_truck_id is not null then
    if exists (select 1 from public.field_reports r where r.company_id = v_company and r.equipment = 'truck' and r.truck_id = p_truck_id
               and r.status in ('open', 'acknowledged') and r.kind in ('breakdown', 'inspection_issue')) then
      v_blockers := v_blockers || 'truck_safety_report_open'::text;
    elsif exists (select 1 from public.field_reports r where r.company_id = v_company and r.equipment = 'truck' and r.truck_id = p_truck_id
                  and r.status in ('open', 'acknowledged') and r.kind = 'equipment_issue') then
      v_warnings := v_warnings || 'truck_equipment_report_open'::text;
    end if;
  end if;
  if p_trailer_id is not null then
    if exists (select 1 from public.field_reports r where r.company_id = v_company and r.equipment = 'trailer' and r.trailer_id = p_trailer_id
               and r.status in ('open', 'acknowledged') and r.kind in ('breakdown', 'inspection_issue')) then
      v_blockers := v_blockers || 'trailer_safety_report_open'::text;
    elsif exists (select 1 from public.field_reports r where r.company_id = v_company and r.equipment = 'trailer' and r.trailer_id = p_trailer_id
                  and r.status in ('open', 'acknowledged') and r.kind = 'equipment_issue') then
      v_warnings := v_warnings || 'trailer_equipment_report_open'::text;
    end if;
  end if;

  -- Maintenance (20261101000100): open safety-critical work orders and shop
  -- visits on the load date. Defensive: a safety-critical order already keeps
  -- the truck out of service.
  if p_truck_id is not null then
    if exists (select 1 from public.work_orders w where w.company_id = v_company and w.truck_id = p_truck_id
               and w.safety_critical and w.status not in ('completed', 'closed', 'canceled')) then
      v_blockers := v_blockers || 'truck_safety_restricted'::text;
    end if;
    if exists (select 1 from public.work_orders w where w.company_id = v_company and w.truck_id = p_truck_id
               and w.scheduled_for = v_on
               and w.status in ('reported', 'triaged', 'scheduled', 'in_progress', 'awaiting_parts')) then
      v_blockers := v_blockers || 'truck_shop_scheduled'::text;
    elsif exists (select 1 from public.work_orders w where w.company_id = v_company and w.truck_id = p_truck_id
                  and w.status in ('in_progress', 'awaiting_parts')) then
      v_warnings := v_warnings || 'truck_shop_work_open'::text;
    end if;
  end if;

  if p_driver_id is not null then
    select * into v_driver from public.drivers where id = p_driver_id and company_id = v_company;
    if not found then raise exception 'Driver not found.'; end if;
    if not v_driver.active then v_blockers := v_blockers || 'driver_inactive'::text; end if;

    -- Time off (20261104000100): approved full days block; a partial day or a pending request warns.
    if exists (select 1 from public.time_off_requests t join public.employees e on e.company_id = t.company_id and e.id = t.employee_id
               where t.company_id = v_company and e.driver_id = p_driver_id and t.status = 'approved' and t.full_day
                 and v_on between t.start_date and t.end_date) then
      v_blockers := v_blockers || 'driver_time_off'::text;
    elsif exists (select 1 from public.time_off_requests t join public.employees e on e.company_id = t.company_id and e.id = t.employee_id
                  where t.company_id = v_company and e.driver_id = p_driver_id and t.status = 'approved' and not t.full_day
                    and v_on = t.start_date) then
      v_warnings := v_warnings || 'driver_partial_time_off'::text;
    end if;
    if exists (select 1 from public.time_off_requests t join public.employees e on e.company_id = t.company_id and e.id = t.employee_id
               where t.company_id = v_company and e.driver_id = p_driver_id and t.status = 'pending'
                 and v_on between t.start_date and t.end_date) then
      v_warnings := v_warnings || 'driver_time_off_pending'::text;
    end if;

    v_min := case when p_trailer_id is not null then 'A'::public.cdl_class else 'B'::public.cdl_class end;
    v_state := private.qualification_check(p_driver_id, 'cdl', v_min, v_on);
    if v_state <> 'ok' then
      v_blockers := v_blockers || ('cdl_' || v_state);
    elsif not exists (select 1 from public.driver_qualifications
                      where driver_id = p_driver_id and kind = 'cdl' and verified_at is not null
                        and private.cdl_class_rank(cdl_class) >= private.cdl_class_rank(v_min)
                        and expires_on > v_soon) then
      v_warnings := v_warnings || 'cdl_expiring_soon'::text;
    end if;

    v_state := private.qualification_check(p_driver_id, 'medical_card', null, v_on);
    if v_state <> 'ok' then
      v_blockers := v_blockers || ('medical_card_' || v_state);
    elsif not exists (select 1 from public.driver_qualifications
                      where driver_id = p_driver_id and kind = 'medical_card' and verified_at is not null
                        and expires_on > v_soon) then
      v_warnings := v_warnings || 'medical_card_expiring_soon'::text;
    end if;
  end if;

  return jsonb_build_object(
    'on', v_on,
    'eligible', cardinality(v_blockers) = 0,
    'blockers', to_jsonb(v_blockers),
    'warnings', to_jsonb(v_warnings));
end;
$function$;

create or replace function private.check_assignment(
  p_company uuid,
  p_truck_id uuid,
  p_trailer_id uuid,
  p_driver_id uuid,
  p_on date,
  p_starts timestamptz,
  p_ends timestamptz,
  p_except uuid
)
returns text[]
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_result   jsonb;
  v_blockers text[];
  v_type     public.truck_type;
  v_conflict text;
begin
  if p_truck_id is null or p_driver_id is null then
    raise exception 'Choose a truck and a driver.';
  end if;
  -- Raises "Truck/Trailer/Driver not found." for ids outside the company.
  v_result := private.assignment_eligibility(p_company, p_truck_id, p_trailer_id, p_driver_id, p_on);
  select array(select jsonb_array_elements_text(v_result -> 'blockers')) into v_blockers;
  select truck_type into v_type from public.trucks where id = p_truck_id and company_id = p_company;
  if v_type = 'tractor' and p_trailer_id is null then
    v_blockers := v_blockers || 'trailer_required'::text;
  end if;
  if cardinality(v_blockers) > 0 then
    raise exception 'Not eligible on %: %', to_char(p_on, 'Mon FMDD, YYYY'),
      (select string_agg(private.eligibility_message(b), ' ') from unnest(v_blockers) b);
  end if;

  -- Approved time off overlapping the load's exact times (20261104000100).
  v_conflict := private.driver_time_off_conflict(p_company, p_driver_id, p_starts, p_ends);
  if v_conflict is not null then
    raise exception '%', v_conflict;
  end if;

  v_conflict := coalesce(
    private.resource_conflict(p_company, 'truck', p_truck_id, p_starts, p_ends, p_except),
    case when p_trailer_id is not null then private.resource_conflict(p_company, 'trailer', p_trailer_id, p_starts, p_ends, p_except) end,
    private.resource_conflict(p_company, 'driver', p_driver_id, p_starts, p_ends, p_except));
  if v_conflict is not null then
    raise exception '%', v_conflict;
  end if;

  return array(select jsonb_array_elements_text(v_result -> 'warnings'));
end;
$$;
