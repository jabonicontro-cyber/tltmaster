-- Rollback of 20261112000100_pto_balances.sql (not a migration; run by hand with a backup first).
-- Restores the time-off functions from 20261104000100 and removes banks, the ledger, the request column and the
-- time_off.balances permission. Balance history is lost: export public.pto_ledger first if it must be kept.
begin;
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


drop function if exists public.pto_balance_overview();
drop function if exists public.pto_balances(uuid);
drop function if exists public.pto_adjust(jsonb);
drop function if exists public.pto_bank_save(jsonb);
drop function if exists private.pto_pending(uuid, uuid, uuid, uuid);
drop function if exists private.pto_balance(uuid, uuid, uuid);
drop table if exists public.pto_ledger;
alter table public.time_off_requests drop constraint if exists time_off_requests_pto_bank;
alter table public.time_off_requests drop column if exists pto_bank_id;
drop table if exists public.pto_banks;
delete from public.role_permissions where permission = 'time_off.balances';
delete from public.role_permission_defaults where permission = 'time_off.balances';
delete from public.permissions where code = 'time_off.balances';
commit;
