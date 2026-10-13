-- =============================================================================
-- PTO banks and balances (Driver Time Off & Availability, slice 2).
--
-- * public.pto_banks — a company's time-off banks. Each bank covers one or more
--   request categories (separate banks, or one combined bank for several
--   categories), the employment types that may use it (policies can differ for
--   full-time and part-time employees) and a waiting period in days from the
--   hire date. A category belongs to at most one active bank. No bank, no
--   balance check: requests in other categories work exactly as before.
-- * public.pto_ledger — append-only balance history per employee and bank:
--   grant and adjustment (a person with time_off.balances, with a reason for
--   adjustments), usage (posted when a request on the bank is approved) and
--   usage_reversal (when approved time off is canceled). The balance is the sum;
--   nothing is edited or deleted, so every change is auditable.
-- * Requests on a bank are refused when the employee is not eligible (type,
--   waiting period, missing hire date), when the hours are unknown, or when
--   they exceed the available balance (balance minus other pending requests);
--   approval re-checks the balance and posts the usage.
-- * Privacy: employees see their own balances and history; time_off.balances
--   (owner by default) sees and manages everyone's. Bank definitions are visible
--   to the company (the request form needs them).
--
-- Not included (next slices, honest limits): accrual engines (annual grant on a
-- date, per hour worked from integrations or entered hours, fixed per pay
-- period), carryover, expiration and use-it-or-lose-it (each needs per-state
-- legal review), approval chains, proration. Amounts are never invented: every
-- hour in a balance comes from a person's grant or adjustment.
--
-- Replaces public.time_off_save, public.time_off_decide and public.time_off_cancel
-- (bodies from 20261104000100 plus the bank checks and ledger postings).
-- Depends on 20261104000100 (time off) and 20261031000100 (employees).
-- Rollback: supabase/rollbacks/20261112000100_pto_balances.down.sql
-- =============================================================================

insert into public.permissions (code, category, description) values
  ('time_off.balances', 'Employees', 'Set up time-off banks, grant and adjust balances, and see everyone''s balances');
insert into public.role_permission_defaults (role, permission) values ('owner', 'time_off.balances');
insert into public.role_permissions (company_id, role, permission)
select c.id, d.role, d.permission
from public.companies c cross join public.role_permission_defaults d
where d.permission = 'time_off.balances'
on conflict do nothing;

create table public.pto_banks (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references public.companies (id),
  name              text not null check (length(trim(name)) between 1 and 60),
  categories        text[] not null check (cardinality(categories) between 1 and 7
                      and categories <@ array['vacation', 'sick', 'personal', 'bereavement', 'jury_duty', 'unpaid', 'other']),
  employment_types  text[] not null check (cardinality(employment_types) between 1 and 4
                      and employment_types <@ array['full_time', 'part_time', 'seasonal', 'contractor']),
  waiting_days      integer not null default 0 check (waiting_days between 0 and 730),
  active            boolean not null default true,
  created_by        uuid references auth.users (id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (company_id, id)
);
create unique index pto_banks_name on public.pto_banks (company_id, lower(trim(name))) where active;

alter table public.time_off_requests add column pto_bank_id uuid;
alter table public.time_off_requests add constraint time_off_requests_pto_bank
  foreign key (company_id, pto_bank_id) references public.pto_banks (company_id, id);

create table public.pto_ledger (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies (id),
  bank_id         uuid not null,
  employee_id     uuid not null,
  kind            text not null check (kind in ('grant', 'adjustment', 'usage', 'usage_reversal')),
  hours           numeric(8, 2) not null check (hours <> 0 and abs(hours) <= 10000),
  effective_on    date not null,
  request_id      uuid,
  note            text not null default '' check (length(note) <= 500),
  submission_key  uuid,
  created_by      uuid references auth.users (id) on delete set null,
  created_at      timestamptz not null default clock_timestamp(),
  foreign key (company_id, bank_id) references public.pto_banks (company_id, id),
  foreign key (company_id, employee_id) references public.employees (company_id, id),
  foreign key (company_id, request_id) references public.time_off_requests (company_id, id),
  constraint pto_ledger_sign check ((kind in ('grant', 'usage_reversal') and hours > 0) or (kind = 'usage' and hours < 0) or kind = 'adjustment'),
  constraint pto_ledger_request check ((kind in ('usage', 'usage_reversal')) = (request_id is not null)),
  constraint pto_ledger_reason check (kind <> 'adjustment' or length(trim(note)) >= 3)
);
create unique index pto_ledger_submission_key on public.pto_ledger (company_id, submission_key) where submission_key is not null;
create unique index pto_ledger_one_usage on public.pto_ledger (company_id, request_id, kind) where request_id is not null;
create index pto_ledger_employee_idx on public.pto_ledger (company_id, employee_id, bank_id, created_at);

create trigger a_company_guard before update of company_id on public.pto_banks
  for each row execute function private.forbid_company_change();
create trigger pto_ledger_append_only before update or delete on public.pto_ledger
  for each row execute function private.prevent_modification();
create trigger pto_banks_audit after insert or update or delete on public.pto_banks
  for each row execute function private.audit_row_change('pto_bank');
create trigger pto_ledger_audit after insert on public.pto_ledger
  for each row execute function private.audit_row_change('pto_ledger_entry');

alter table public.pto_banks enable row level security;
alter table public.pto_ledger enable row level security;
create policy pto_banks_read on public.pto_banks for select to authenticated
  using (company_id = (select private.current_company_id()));
create policy pto_ledger_read on public.pto_ledger for select to authenticated
  using (company_id = (select private.current_company_id())
         and ((select private.has_permission('time_off.balances')) or private.is_own_employee(employee_id)));
revoke all on public.pto_banks, public.pto_ledger from anon, authenticated;
grant select on public.pto_banks, public.pto_ledger to authenticated;
grant all on public.pto_banks, public.pto_ledger to service_role;

-- Sum of an employee's entries on a bank (internal; callers check access).
create or replace function private.pto_balance(p_company uuid, p_employee uuid, p_bank uuid)
returns numeric
language sql
stable
set search_path = ''
as $$
  select coalesce(sum(l.hours), 0) from public.pto_ledger l
  where l.company_id = p_company and l.employee_id = p_employee and l.bank_id = p_bank
$$;

-- Hours of the employee's pending requests on a bank, except one request (internal).
create or replace function private.pto_pending(p_company uuid, p_employee uuid, p_bank uuid, p_except uuid)
returns numeric
language sql
stable
set search_path = ''
as $$
  select coalesce(sum(t.hours), 0) from public.time_off_requests t
  where t.company_id = p_company and t.employee_id = p_employee and t.pto_bank_id = p_bank
    and t.status = 'pending' and t.id is distinct from p_except
$$;

/**
 * Create or change a bank (time_off.balances).
 * p: { id?, name, categories[], employment_types[], waiting_days, active? }
 */
create or replace function public.pto_bank_save(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v_id      uuid := nullif(p ->> 'id', '')::uuid;
  v_name    text := trim(coalesce(p ->> 'name', ''));
  v_cats    text[] := array(select distinct jsonb_array_elements_text(coalesce(p -> 'categories', '[]'::jsonb)) order by 1);
  v_types   text[] := array(select distinct jsonb_array_elements_text(coalesce(p -> 'employment_types', '[]'::jsonb)) order by 1);
  v_wait    integer := coalesce(nullif(p ->> 'waiting_days', '')::integer, 0);
  v_active  boolean := coalesce((p ->> 'active')::boolean, true);
  v_taken   text;
begin
  perform private.require_permission('time_off.balances');
  if length(v_name) < 1 or length(v_name) > 60 then raise exception 'Enter a bank name (up to 60 characters).' using errcode = 'P0001'; end if;
  if cardinality(v_cats) = 0 then raise exception 'Choose at least one kind of time off for this bank.' using errcode = 'P0001'; end if;
  if cardinality(v_types) = 0 then raise exception 'Choose who can use this bank (employment types).' using errcode = 'P0001'; end if;
  if v_wait < 0 or v_wait > 730 then raise exception 'The waiting period is 0 to 730 days.' using errcode = 'P0001'; end if;
  -- Serialize bank changes per company so a category never ends up in two active banks.
  perform 1 from public.companies where id = v_company for update;
  if v_active then
    select b.name into v_taken from public.pto_banks b
    where b.company_id = v_company and b.active and b.id is distinct from v_id and b.categories && v_cats limit 1;
    if v_taken is not null then
      raise exception 'A kind of time off can draw from one bank only; % already covers one of these.', v_taken using errcode = 'P0001';
    end if;
  end if;
  if v_id is null then
    insert into public.pto_banks (company_id, name, categories, employment_types, waiting_days, active, created_by)
    values (v_company, v_name, v_cats, v_types, v_wait, v_active, auth.uid())
    returning id into v_id;
  else
    update public.pto_banks set name = v_name, categories = v_cats, employment_types = v_types, waiting_days = v_wait,
      active = v_active, updated_at = now()
    where id = v_id and company_id = v_company;
    if not found then raise exception 'Bank not found.' using errcode = 'P0002'; end if;
  end if;
  return jsonb_build_object('id', v_id);
exception
  when unique_violation then
    raise exception 'Another active bank already has this name.' using errcode = 'P0001';
end;
$$;

/**
 * Grant hours to an employee, or adjust a balance with a reason (time_off.balances). A grant adds hours; an
 * adjustment adds or removes them and never takes the balance below zero. Repeating a submission key adds nothing.
 * p: { employee_id, bank_id, kind: 'grant' | 'adjustment', hours, effective_on?, note, submission_key? }
 */
create or replace function public.pto_adjust(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v_kind    text := coalesce(p ->> 'kind', '');
  v_hours   numeric := round(nullif(p ->> 'hours', '')::numeric, 2);
  v_on      date := coalesce(nullif(p ->> 'effective_on', '')::date, private.business_today(v_company));
  v_note    text := private.clean_text(p ->> 'note', 500, 'Reason');
  v_key     uuid := nullif(p ->> 'submission_key', '')::uuid;
  v_emp     public.employees%rowtype;
  v_bank    public.pto_banks%rowtype;
  v_balance numeric;
  v_id      uuid;
begin
  perform private.require_permission('time_off.balances');
  if v_key is not null then
    select l.id, private.pto_balance(v_company, l.employee_id, l.bank_id) into v_id, v_balance
    from public.pto_ledger l where l.company_id = v_company and l.submission_key = v_key;
    if found then
      return jsonb_build_object('id', v_id, 'duplicate', true, 'balance', v_balance);
    end if;
  end if;
  if v_kind not in ('grant', 'adjustment') then raise exception 'Choose a grant or an adjustment.' using errcode = 'P0001'; end if;
  if v_hours is null or v_hours = 0 or abs(v_hours) > 10000 then raise exception 'Enter the hours (not zero).' using errcode = 'P0001'; end if;
  if v_kind = 'grant' and v_hours < 0 then raise exception 'A grant adds hours; use an adjustment to remove hours.' using errcode = 'P0001'; end if;
  if v_kind = 'adjustment' and length(trim(v_note)) < 3 then raise exception 'Say why the balance is adjusted.' using errcode = 'P0001'; end if;
  if v_on > private.business_today(v_company) then raise exception 'Hours cannot be dated in the future.' using errcode = 'P0001'; end if;
  select * into v_emp from public.employees where id = nullif(p ->> 'employee_id', '')::uuid and company_id = v_company for update;
  if not found then raise exception 'Employee not found.' using errcode = 'P0002'; end if;
  select * into v_bank from public.pto_banks where id = nullif(p ->> 'bank_id', '')::uuid and company_id = v_company;
  if not found then raise exception 'Bank not found.' using errcode = 'P0002'; end if;
  if v_kind = 'grant' and not (v_emp.employment_type = any (v_bank.employment_types)) then
    raise exception '% is not available to % employees.', v_bank.name, replace(v_emp.employment_type, '_', '-') using errcode = 'P0001';
  end if;
  v_balance := private.pto_balance(v_company, v_emp.id, v_bank.id);
  if v_balance + v_hours < 0 then
    raise exception 'This would take the balance below zero (balance % h).', trim_scale(v_balance) using errcode = 'P0001';
  end if;
  insert into public.pto_ledger (company_id, bank_id, employee_id, kind, hours, effective_on, note, submission_key, created_by)
  values (v_company, v_bank.id, v_emp.id, v_kind, v_hours, v_on, v_note, v_key, auth.uid())
  returning id into v_id;
  return jsonb_build_object('id', v_id, 'duplicate', false, 'balance', v_balance + v_hours);
exception
  when unique_violation then
    select id into v_id from public.pto_ledger where company_id = v_company and submission_key = v_key;
    if found then return jsonb_build_object('id', v_id, 'duplicate', true, 'balance', null); end if;
    raise;
end;
$$;

/**
 * Balances per active bank: the caller's own (p_employee null) or one employee's (own, or time_off.balances).
 * Each row: bank, balance, pending, available, whether the employee can use the bank and from when.
 */
create or replace function public.pto_balances(p_employee uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v_emp     public.employees%rowtype;
begin
  if p_employee is null then
    select * into v_emp from public.employees where company_id = v_company and user_id = auth.uid();
    if not found then return '[]'::jsonb; end if;
  else
    select * into v_emp from public.employees where id = p_employee and company_id = v_company;
    if not found then raise exception 'Employee not found.' using errcode = 'P0002'; end if;
    if v_emp.user_id is distinct from auth.uid() then
      perform private.require_permission('time_off.balances');
    end if;
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'bank_id', b.id, 'name', b.name, 'categories', to_jsonb(b.categories),
      'balance', s.balance, 'pending', s.pending, 'available', s.balance - s.pending,
      'eligible', v_emp.employment_type = any (b.employment_types),
      'usable_from', case when b.waiting_days > 0 and v_emp.hire_date is not null then v_emp.hire_date + b.waiting_days end,
      'waiting_days', b.waiting_days, 'hire_date_missing', b.waiting_days > 0 and v_emp.hire_date is null)
      order by lower(b.name))
    from public.pto_banks b
    cross join lateral (select private.pto_balance(v_company, v_emp.id, b.id) as balance,
                               private.pto_pending(v_company, v_emp.id, b.id, null) as pending) s
    where b.company_id = v_company and b.active
      and (v_emp.employment_type = any (b.employment_types) or s.balance <> 0)), '[]'::jsonb);
end;
$$;

/** Everyone's balances on the active banks (time_off.balances): current employees, one row per employee and bank. */
create or replace function public.pto_balance_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
begin
  perform private.require_permission('time_off.balances');
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'employee_id', e.id, 'employee_name', e.full_name, 'employment_type', e.employment_type, 'hire_date', e.hire_date,
      'bank_id', b.id, 'bank_name', b.name, 'eligible', e.employment_type = any (b.employment_types),
      'balance', s.balance, 'pending', s.pending, 'available', s.balance - s.pending)
      order by lower(e.full_name), lower(b.name))
    from public.employees e
    join public.pto_banks b on b.company_id = e.company_id and b.active
    cross join lateral (select private.pto_balance(v_company, e.id, b.id) as balance,
                               private.pto_pending(v_company, e.id, b.id, null) as pending) s
    where e.company_id = v_company and e.status in ('active', 'on_leave')
      and (e.employment_type = any (b.employment_types) or s.balance <> 0)), '[]'::jsonb);
end;
$$;

revoke all on function private.pto_balance(uuid, uuid, uuid), private.pto_pending(uuid, uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.pto_bank_save(jsonb), public.pto_adjust(jsonb), public.pto_balances(uuid), public.pto_balance_overview() from public, anon;
grant execute on function public.pto_bank_save(jsonb), public.pto_adjust(jsonb), public.pto_balances(uuid), public.pto_balance_overview() to authenticated;

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
  v_category text;
  v_bank     public.pto_banks%rowtype;
  v_balance  numeric;
  v_pending  numeric;
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
  v_balance   numeric;
  v_bank_name text;
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
  -- A request on a PTO bank uses its hours when approved: checked against the balance at this moment (the employee row
  -- is locked so concurrent approvals and adjustments cannot both spend the same hours), then posted to the ledger.
  if p_decision = 'approved' and v_req.pto_bank_id is not null then
    perform 1 from public.employees where id = v_req.employee_id and company_id = v_company for update;
    v_balance := private.pto_balance(v_company, v_req.employee_id, v_req.pto_bank_id);
    select name into v_bank_name from public.pto_banks where id = v_req.pto_bank_id;
    if v_req.hours is null or v_req.hours > v_balance then
      raise exception 'Approving uses % h of %, but the balance is % h. Adjust the balance or ask for a shorter request.',
        trim_scale(coalesce(v_req.hours, 0)), v_bank_name, trim_scale(v_balance) using errcode = 'P0001';
    end if;
    insert into public.pto_ledger (company_id, bank_id, employee_id, kind, hours, effective_on, request_id, note, created_by)
    values (v_company, v_req.pto_bank_id, v_req.employee_id, 'usage', -v_req.hours, v_req.start_date, p_id, '', auth.uid());
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
  -- Canceling approved time off gives its hours back (the usage stays in the history; a reversal is added).
  insert into public.pto_ledger (company_id, bank_id, employee_id, kind, hours, effective_on, request_id, note, created_by)
  select u.company_id, u.bank_id, u.employee_id, 'usage_reversal', -u.hours, private.business_today(v_company), p_id, '', auth.uid()
  from public.pto_ledger u
  where u.company_id = v_company and u.request_id = p_id and u.kind = 'usage'
    and not exists (select 1 from public.pto_ledger r where r.company_id = v_company and r.request_id = p_id and r.kind = 'usage_reversal');
  perform private.time_off_event(v_company, p_id, 'canceled', p_note, jsonb_build_object('was', v_req.status));
end;
$$;

