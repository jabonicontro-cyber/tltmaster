-- =============================================================================
-- PTO accruals (Driver Time Off & Availability, slice 2; owner 2026-10-13).
--
-- * public.pto_policies — how a bank earns hours, per employment type (policies
--   differ for full- and part-time employees). Three methods, all company-set,
--   none assumed:
--     annual_grant    — `amount` hours on a set month/day each year;
--     hours_worked    — `amount` hours per `per_hours` eligible hours worked
--                       (from entered hours or an integration);
--     per_pay_period  — `amount` hours each weekly / biweekly / semimonthly /
--                       monthly pay period, counted from `anchor_date`.
--   Optional `max_balance` (accrual stops at the cap), and a plan-year rule:
--   `carryover_cap` (null = unlimited carryover; a number = hours above it are
--   forfeited at the start of the plan year; 0 = use-it-or-lose-it). Forfeiture
--   is refused unless `forfeiture_reviewed` is set: some jurisdictions forbid
--   it, and Taviron never decides that.
-- * public.pto_hours_worked — eligible hours per employee and period, entered by
--   a person or written by an integration (`source`), the basis of hours-worked
--   accrual. Corrections are new rows (append-only).
-- * public.pto_run_accruals(through) — posts every accrual and forfeiture due up
--   to a date, once: each ledger entry carries a period key and a unique index
--   makes a repeated run add nothing. Employees must be current, of the policy's
--   type and past the bank's waiting period. Hours are rounded to 0.01 h, half up.
--   The run is a person's action (time_off.balances): no scheduler exists.
--
-- Extends public.pto_ledger with kinds 'accrual' and 'forfeiture', a period key
-- and the policy that produced an entry.
-- Depends on 20261112000100 (PTO banks and balances).
-- Rollback: supabase/rollbacks/20261112000300_pto_accruals.down.sql
-- =============================================================================

alter table public.pto_ledger drop constraint pto_ledger_kind_check;
alter table public.pto_ledger add constraint pto_ledger_kind_check
  check (kind in ('grant', 'adjustment', 'usage', 'usage_reversal', 'accrual', 'forfeiture'));
alter table public.pto_ledger drop constraint pto_ledger_sign;
alter table public.pto_ledger add constraint pto_ledger_sign check (
  (kind in ('grant', 'usage_reversal', 'accrual') and hours > 0) or (kind in ('usage', 'forfeiture') and hours < 0) or kind = 'adjustment');
alter table public.pto_ledger add column period_key text check (period_key is null or length(period_key) <= 80);
alter table public.pto_ledger add column policy_id uuid;
create unique index pto_ledger_period on public.pto_ledger (company_id, employee_id, bank_id, period_key) where period_key is not null;

create table public.pto_policies (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid not null references public.companies (id),
  bank_id               uuid not null,
  employment_type       text not null check (employment_type in ('full_time', 'part_time', 'seasonal', 'contractor')),
  method                text not null check (method in ('annual_grant', 'hours_worked', 'per_pay_period')),
  amount                numeric(8, 2) not null check (amount > 0 and amount <= 2000),
  per_hours             numeric(8, 2) check (per_hours is null or (per_hours > 0 and per_hours <= 2000)),
  grant_month           integer check (grant_month between 1 and 12),
  grant_day             integer check (grant_day between 1 and 28),
  pay_period            text check (pay_period in ('weekly', 'biweekly', 'semimonthly', 'monthly')),
  anchor_date           date,
  max_balance           numeric(8, 2) check (max_balance is null or max_balance > 0),
  plan_year_month       integer not null default 1 check (plan_year_month between 1 and 12),
  plan_year_day         integer not null default 1 check (plan_year_day between 1 and 28),
  carryover_cap         numeric(8, 2) check (carryover_cap is null or carryover_cap >= 0),
  forfeiture_reviewed   boolean not null default false,
  effective_from        date not null,
  active                boolean not null default true,
  created_by            uuid references auth.users (id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (company_id, id),
  foreign key (company_id, bank_id) references public.pto_banks (company_id, id),
  constraint pto_policy_method check (
    (method = 'annual_grant' and grant_month is not null and grant_day is not null)
    or (method = 'hours_worked' and per_hours is not null)
    or (method = 'per_pay_period' and pay_period is not null and anchor_date is not null)),
  constraint pto_policy_forfeiture check (carryover_cap is null or forfeiture_reviewed)
);
create unique index pto_policies_one_active on public.pto_policies (company_id, bank_id, employment_type) where active;
alter table public.pto_ledger add constraint pto_ledger_policy foreign key (company_id, policy_id) references public.pto_policies (company_id, id);

create table public.pto_hours_worked (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies (id),
  employee_id   uuid not null,
  period_start  date not null,
  period_end    date not null,
  hours         numeric(8, 2) not null check (hours >= 0 and hours <= 1000),
  source        text not null default 'manual' check (source in ('manual', 'integration')),
  note          text not null default '' check (length(note) <= 300),
  submission_key uuid,
  created_by    uuid references auth.users (id) on delete set null,
  created_at    timestamptz not null default clock_timestamp(),
  foreign key (company_id, employee_id) references public.employees (company_id, id),
  constraint pto_hours_period check (period_end >= period_start and period_end - period_start <= 31)
);
create unique index pto_hours_submission on public.pto_hours_worked (company_id, submission_key) where submission_key is not null;
create index pto_hours_employee_idx on public.pto_hours_worked (company_id, employee_id, period_end);

create trigger a_company_guard before update of company_id on public.pto_policies
  for each row execute function private.forbid_company_change();
create trigger pto_policies_audit after insert or update or delete on public.pto_policies
  for each row execute function private.audit_row_change('pto_policy');
create trigger pto_hours_append_only before update or delete on public.pto_hours_worked
  for each row execute function private.prevent_modification();
create trigger pto_hours_audit after insert on public.pto_hours_worked
  for each row execute function private.audit_row_change('pto_hours_worked');

alter table public.pto_policies enable row level security;
alter table public.pto_hours_worked enable row level security;
create policy pto_policies_read on public.pto_policies for select to authenticated
  using (company_id = (select private.current_company_id()));
create policy pto_hours_read on public.pto_hours_worked for select to authenticated
  using (company_id = (select private.current_company_id())
         and ((select private.has_permission('time_off.balances')) or private.is_own_employee(employee_id)));
revoke all on public.pto_policies, public.pto_hours_worked from anon, authenticated;
grant select on public.pto_policies, public.pto_hours_worked to authenticated;
grant all on public.pto_policies, public.pto_hours_worked to service_role;

/**
 * Create or replace the active policy of a bank for one employment type (time_off.balances). A change deactivates the
 * previous policy (kept for history; entries it posted keep pointing at it).
 */
create or replace function public.pto_policy_save(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v_bank    public.pto_banks%rowtype;
  v_type    text := p ->> 'employment_type';
  v_method  text := p ->> 'method';
  v_cap     numeric := nullif(p ->> 'carryover_cap', '')::numeric;
  v_id      uuid;
begin
  perform private.require_permission('time_off.balances');
  select * into v_bank from public.pto_banks where id = nullif(p ->> 'bank_id', '')::uuid and company_id = v_company;
  if not found then raise exception 'Bank not found.' using errcode = 'P0002'; end if;
  if not (v_type = any (v_bank.employment_types)) then
    raise exception '% is not available to % employees; add the type to the bank first.', v_bank.name, replace(coalesce(v_type, ''), '_', '-') using errcode = 'P0001';
  end if;
  if v_cap is not null and not coalesce((p ->> 'forfeiture_reviewed')::boolean, false) then
    raise exception 'Forfeiting hours at the end of the plan year is not allowed everywhere. Confirm the rule was reviewed for where your employees work before setting a carryover cap.' using errcode = 'P0001';
  end if;
  perform 1 from public.pto_banks where id = v_bank.id for update;
  update public.pto_policies set active = false, updated_at = now()
  where company_id = v_company and bank_id = v_bank.id and employment_type = v_type and active;
  insert into public.pto_policies (company_id, bank_id, employment_type, method, amount, per_hours, grant_month, grant_day, pay_period,
                                   anchor_date, max_balance, plan_year_month, plan_year_day, carryover_cap, forfeiture_reviewed,
                                   effective_from, created_by)
  values (v_company, v_bank.id, v_type, v_method, nullif(p ->> 'amount', '')::numeric,
          case when v_method = 'hours_worked' then nullif(p ->> 'per_hours', '')::numeric end,
          case when v_method = 'annual_grant' then nullif(p ->> 'grant_month', '')::integer end,
          case when v_method = 'annual_grant' then nullif(p ->> 'grant_day', '')::integer end,
          case when v_method = 'per_pay_period' then nullif(p ->> 'pay_period', '') end,
          case when v_method = 'per_pay_period' then nullif(p ->> 'anchor_date', '')::date end,
          nullif(p ->> 'max_balance', '')::numeric,
          coalesce(nullif(p ->> 'plan_year_month', '')::integer, 1), coalesce(nullif(p ->> 'plan_year_day', '')::integer, 1),
          v_cap, coalesce((p ->> 'forfeiture_reviewed')::boolean, false),
          coalesce(nullif(p ->> 'effective_from', '')::date, private.business_today(v_company)), auth.uid())
  returning id into v_id;
  return jsonb_build_object('id', v_id);
exception
  when check_violation then
    raise exception 'The policy is incomplete: an annual grant needs a month and day, hours worked needs "per hours", a pay-period policy needs the period and a first period start.' using errcode = 'P0001';
end;
$$;

/** Turn a policy off (time_off.balances). Hours already posted stay. */
create or replace function public.pto_policy_end(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.require_permission('time_off.balances');
  update public.pto_policies set active = false, updated_at = now() where id = p_id and company_id = private.require_company() and active;
  if not found then raise exception 'Policy not found.' using errcode = 'P0002'; end if;
end;
$$;

/** Record eligible hours worked for an employee and period (time_off.balances); the basis of hours-worked accrual. */
create or replace function public.pto_record_hours(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v_key     uuid := nullif(p ->> 'submission_key', '')::uuid;
  v_id      uuid;
begin
  perform private.require_permission('time_off.balances');
  if v_key is not null then
    select id into v_id from public.pto_hours_worked where company_id = v_company and submission_key = v_key;
    if found then return jsonb_build_object('id', v_id, 'duplicate', true); end if;
  end if;
  perform 1 from public.employees where id = nullif(p ->> 'employee_id', '')::uuid and company_id = v_company;
  if not found then raise exception 'Employee not found.' using errcode = 'P0002'; end if;
  if nullif(p ->> 'period_end', '')::date > private.business_today(v_company) then
    raise exception 'Hours can only be recorded for periods that have ended.' using errcode = 'P0001';
  end if;
  insert into public.pto_hours_worked (company_id, employee_id, period_start, period_end, hours, source, note, submission_key, created_by)
  values (v_company, (p ->> 'employee_id')::uuid, (p ->> 'period_start')::date, (p ->> 'period_end')::date,
          round((p ->> 'hours')::numeric, 2), 'manual', private.clean_text(p ->> 'note', 300, 'Note'), v_key, auth.uid())
  returning id into v_id;
  return jsonb_build_object('id', v_id, 'duplicate', false);
exception
  when check_violation then
    raise exception 'Enter a period of at most 31 days (end on or after start) and 0 to 1000 hours.' using errcode = 'P0001';
end;
$$;

-- Post one accrual (capped at max_balance) under a period key; a repeated key adds nothing. Internal.
create or replace function private.pto_post_accrual(p_company uuid, pol public.pto_policies, p_employee uuid, p_hours numeric, p_on date, p_key text, p_note text)
returns numeric
language plpgsql
set search_path = ''
as $$
declare
  v_hours   numeric := round(p_hours, 2);
  v_balance numeric;
begin
  if exists (select 1 from public.pto_ledger where company_id = p_company and employee_id = p_employee and bank_id = pol.bank_id and period_key = p_key) then
    return 0;
  end if;
  if pol.max_balance is not null then
    v_balance := private.pto_balance(p_company, p_employee, pol.bank_id);
    v_hours := least(v_hours, greatest(pol.max_balance - v_balance, 0));
  end if;
  if v_hours <= 0 then
    return 0;
  end if;
  insert into public.pto_ledger (company_id, bank_id, employee_id, kind, hours, effective_on, note, period_key, policy_id, created_by)
  values (p_company, pol.bank_id, p_employee, 'accrual', v_hours, p_on, p_note, p_key, pol.id, auth.uid());
  return v_hours;
end;
$$;

/**
 * Post every accrual and plan-year forfeiture due up to p_through, once (time_off.balances). Returns counts.
 * Per employee and bank: accruals first, then forfeiture at each plan-year start (balance summed by effective date).
 */
create or replace function public.pto_run_accruals(p_through date default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company  uuid := private.require_company();
  v_through  date := least(coalesce(p_through, private.business_today(v_company)), private.business_today(v_company));
  pol        public.pto_policies%rowtype;
  v_bank     public.pto_banks%rowtype;
  e          public.employees%rowtype;
  v_start    date;
  v_d        date;
  v_next     date;
  v_year     integer;
  v_posted   numeric;
  v_entries  integer := 0;
  v_hours    numeric := 0;
  v_forfeit  integer := 0;
  v_balance  numeric;
  h          record;
begin
  perform private.require_permission('time_off.balances');
  for pol in select * from public.pto_policies where company_id = v_company and active order by created_at loop
    select * into v_bank from public.pto_banks where id = pol.bank_id;
    continue when not v_bank.active;
    for e in select * from public.employees where company_id = v_company and employment_type = pol.employment_type
             and status in ('active', 'on_leave') order by id for update loop
      -- Eligible from the later of the policy start, the hire date and the end of the waiting period.
      if v_bank.waiting_days > 0 and e.hire_date is null then
        continue;  -- the waiting period cannot be checked; the balances page names the missing hire date
      end if;
      v_start := greatest(pol.effective_from, coalesce(e.hire_date + v_bank.waiting_days, pol.effective_from));
      continue when v_start > v_through;

      if pol.method = 'annual_grant' then
        for v_year in extract(year from v_start)::integer .. extract(year from v_through)::integer loop
          v_d := make_date(v_year, pol.grant_month, pol.grant_day);
          continue when v_d < v_start or v_d > v_through;
          v_posted := private.pto_post_accrual(v_company, pol, e.id, pol.amount, v_d, 'annual:' || v_year, 'Annual grant (company policy).');
          if v_posted > 0 then v_entries := v_entries + 1; v_hours := v_hours + v_posted; end if;
        end loop;
      elsif pol.method = 'hours_worked' then
        for h in select * from public.pto_hours_worked w where w.company_id = v_company and w.employee_id = e.id
                 and w.period_start >= v_start and w.period_end <= v_through and w.hours > 0 order by w.period_end, w.created_at loop
          v_posted := private.pto_post_accrual(v_company, pol, e.id, h.hours * pol.amount / pol.per_hours, h.period_end, 'hours:' || h.id,
                        format('%s h per %s h worked: %s h worked %s – %s.', trim_scale(pol.amount), trim_scale(pol.per_hours), trim_scale(h.hours),
                               to_char(h.period_start, 'Mon FMDD'), to_char(h.period_end, 'Mon FMDD, YYYY')));
          if v_posted > 0 then v_entries := v_entries + 1; v_hours := v_hours + v_posted; end if;
        end loop;
      else
        -- Pay periods from the anchor; a period accrues on its last day once it has ended and the employee was
        -- eligible on its first day.
        v_d := pol.anchor_date;
        while v_d <= v_through loop
          v_next := case pol.pay_period
            when 'weekly' then v_d + 7
            when 'biweekly' then v_d + 14
            when 'monthly' then (v_d + interval '1 month')::date
            else case when extract(day from v_d) < 16 then date_trunc('month', v_d)::date + 15 else (date_trunc('month', v_d) + interval '1 month')::date end
          end;
          exit when v_next - 1 > v_through;
          if v_d >= v_start then
            v_posted := private.pto_post_accrual(v_company, pol, e.id, pol.amount, v_next - 1, 'period:' || v_d, format('Pay period %s – %s (company policy).', to_char(v_d, 'Mon FMDD'), to_char(v_next - 1, 'Mon FMDD, YYYY')));
            if v_posted > 0 then v_entries := v_entries + 1; v_hours := v_hours + v_posted; end if;
          end if;
          v_d := v_next;
        end loop;
      end if;

      -- Plan-year forfeiture (carryover cap) at each plan-year start after the employee became eligible. After the
      -- accruals, because the balance before each plan-year start is summed by effective date.
      if pol.carryover_cap is not null and pol.forfeiture_reviewed then
        for v_year in extract(year from v_start)::integer .. extract(year from v_through)::integer loop
          v_d := make_date(v_year, pol.plan_year_month, pol.plan_year_day);
          continue when v_d <= v_start or v_d > v_through;
          continue when exists (select 1 from public.pto_ledger where company_id = v_company and employee_id = e.id and bank_id = pol.bank_id and period_key = 'yearend:' || v_year);
          select coalesce(sum(l.hours), 0) into v_balance from public.pto_ledger l
          where l.company_id = v_company and l.employee_id = e.id and l.bank_id = pol.bank_id and l.effective_on < v_d;
          if v_balance > pol.carryover_cap then
            insert into public.pto_ledger (company_id, bank_id, employee_id, kind, hours, effective_on, note, period_key, policy_id, created_by)
            values (v_company, pol.bank_id, e.id, 'forfeiture', -round(v_balance - pol.carryover_cap, 2), v_d,
                    format('Plan year start: hours above the carryover cap of %s h are forfeited (company policy).', trim_scale(pol.carryover_cap)),
                    'yearend:' || v_year, pol.id, auth.uid());
            v_forfeit := v_forfeit + 1;
          end if;
        end loop;
      end if;
    end loop;
  end loop;
  return jsonb_build_object('through', v_through, 'entries', v_entries, 'hours', v_hours, 'forfeitures', v_forfeit);
end;
$$;

revoke all on function private.pto_post_accrual(uuid, public.pto_policies, uuid, numeric, date, text, text) from public, anon, authenticated;
revoke all on function public.pto_policy_save(jsonb), public.pto_policy_end(uuid), public.pto_record_hours(jsonb), public.pto_run_accruals(date) from public, anon;
grant execute on function public.pto_policy_save(jsonb), public.pto_policy_end(uuid), public.pto_record_hours(jsonb), public.pto_run_accruals(date) to authenticated;
