-- =============================================================================
-- Driver payroll from delivery tickets (2026-10-18, master plan B27; owner directives "Delivery-ticket-based driver
-- payroll", "Payroll rules discovery", "Company-specific earnings formula engine").
--
-- Taviron has no built-in pay rule. Each company writes its own formula (src/lib/payroll/formula.ts: a whitelist of
-- inputs and operators, exact decimals, one rounding to cents), versioned with effective dates and activated by an
-- authorized person. Delivery tickets stay the single source of earnings (public.delivery_tickets: number, revision
-- history, review status, driver, quantity, unit, photos); nothing here is a second ticket system.
--
--   payroll_settings         per company: calculation enabled (off by default — nothing is paid automatically until
--                            the company turns it on), which ticket status is payable, period length and anchor.
--   pay_rules / pay_rule_versions
--                            named rules; each version: formula, rate, unit, scope (driver / customer / order /
--                            material / truck), effective dates, evidence note; draft → active (approved by whom, when)
--                            → retired. Active versions never change; a change is a new version.
--   payroll_periods          open → in_review → approved (locked, totals snapshot) → exported → reconciled.
--   payroll_entries          one per eligible ticket and driver: rule version, inputs, breakdown, amount; or an
--                            exception (missing input, no rule, conflict) for review. At most one live entry per
--                            ticket and driver (no double pay); a reversal keeps the history.
--   payroll_adjustments      owner-entered additions or deductions with a reason (no automatic deductions).
--   payroll_exports          what was exported, when, by whom, its content hash (a repeat is the same export), and
--                            whether the destination accepted it.
--
-- Access: the new permission payroll.manage (owner by default; companies can grant it in Settings → Roles, never
-- silently). Tables are readable only with payroll.manage in the caller's company; every change goes through the
-- functions below, which check the permission, the company and the period state, and write the audit log.
-- Rollback: supabase/rollbacks/20261118000200_driver_payroll.down.sql
-- =============================================================================

insert into public.permissions (code, category, description) values
  ('payroll.manage', 'Payroll', 'Set pay rules, review drivers'' earnings from delivery tickets, approve and export payroll periods');
insert into public.role_permission_defaults (role, permission) values ('owner', 'payroll.manage');
insert into public.role_permissions (company_id, role, permission)
select c.id, d.role, d.permission from public.companies c cross join public.role_permission_defaults d
where d.permission = 'payroll.manage'
on conflict do nothing;

create table public.payroll_settings (
  company_id      uuid primary key references public.companies (id),
  enabled         boolean not null default false,
  payable_status  text not null default 'accepted' check (payable_status in ('accepted')),
  period_length   text check (period_length in ('weekly', 'biweekly', 'semimonthly', 'monthly')),
  period_anchor   date,
  updated_by      uuid references auth.users (id) on delete set null,
  updated_at      timestamptz not null default now()
);

create table public.pay_rules (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies (id),
  name        text not null check (length(trim(name)) between 1 and 80),
  created_by  uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  unique (company_id, name)
);

create table public.pay_rule_versions (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies (id),
  rule_id         uuid not null references public.pay_rules (id),
  version         integer not null,
  status          text not null default 'draft' check (status in ('draft', 'active', 'retired')),
  formula         text not null check (length(formula) between 1 and 500 and formula ~ '^[a-z_0-9.+*/(),<>=! -]+$'),
  rate            numeric(14, 6) check (rate is null or rate >= 0),
  unit_code       text,
  scope           jsonb not null default '{}'::jsonb,
  effective_from  date not null,
  effective_to    date check (effective_to is null or effective_to >= effective_from),
  evidence_note   text not null default '' check (length(evidence_note) <= 2000),
  created_by      uuid references auth.users (id) on delete set null,
  created_at      timestamptz not null default now(),
  approved_by     uuid references auth.users (id) on delete set null,
  approved_at     timestamptz,
  unique (rule_id, version),
  check (status = 'draft' or approved_at is not null)
);
create index pay_rule_versions_company on public.pay_rule_versions (company_id, status);

create table public.payroll_periods (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies (id),
  starts_on    date not null,
  ends_on      date not null check (ends_on >= starts_on),
  status       text not null default 'open' check (status in ('open', 'in_review', 'approved', 'exported', 'reconciled')),
  totals       jsonb,
  approved_by  uuid references auth.users (id) on delete set null,
  approved_at  timestamptz,
  reconciled_note text not null default '',
  created_by   uuid references auth.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  unique (company_id, starts_on)
);

create table public.payroll_entries (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references public.companies (id),
  period_id        uuid not null references public.payroll_periods (id),
  ticket_id        uuid not null references public.delivery_tickets (id),
  driver_id        uuid not null references public.drivers (id),
  rule_version_id  uuid references public.pay_rule_versions (id),
  status           text not null check (status in ('calculated', 'exception', 'excluded', 'reversed')),
  inputs           jsonb not null default '{}'::jsonb,
  breakdown        text not null default '',
  amount_cents     bigint,
  exception        text not null default '',
  note             text not null default '',
  calculated_by    uuid references auth.users (id) on delete set null,
  calculated_at    timestamptz not null default now(),
  changed_by       uuid references auth.users (id) on delete set null,
  changed_at       timestamptz,
  check ((status = 'calculated') = (amount_cents is not null and rule_version_id is not null))
);
-- One live entry per ticket and driver: a ticket is never paid twice, whatever re-entry or retry happens.
create unique index payroll_entries_once on public.payroll_entries (ticket_id, driver_id) where status <> 'reversed';
create index payroll_entries_period on public.payroll_entries (period_id, driver_id);

create table public.payroll_adjustments (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies (id),
  period_id     uuid not null references public.payroll_periods (id),
  driver_id     uuid not null references public.drivers (id),
  entry_id      uuid references public.payroll_entries (id),
  amount_cents  bigint not null check (amount_cents <> 0),
  reason        text not null check (length(trim(reason)) between 3 and 500),
  created_by    uuid references auth.users (id) on delete set null,
  created_at    timestamptz not null default now()
);

create table public.payroll_exports (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies (id),
  period_id     uuid not null references public.payroll_periods (id),
  format        text not null check (format in ('summary_csv', 'detail_csv')),
  content_hash  text not null check (length(content_hash) = 64),
  row_count     integer not null,
  total_cents   bigint not null,
  status        text not null default 'prepared' check (status in ('prepared', 'accepted', 'rejected', 'failed')),
  reference     text not null default '',
  note          text not null default '',
  created_by    uuid references auth.users (id) on delete set null,
  created_at    timestamptz not null default now(),
  decided_by    uuid references auth.users (id) on delete set null,
  decided_at    timestamptz,
  unique (period_id, format, content_hash)
);

alter table public.payroll_settings enable row level security;
alter table public.pay_rules enable row level security;
alter table public.pay_rule_versions enable row level security;
alter table public.payroll_periods enable row level security;
alter table public.payroll_entries enable row level security;
alter table public.payroll_adjustments enable row level security;
alter table public.payroll_exports enable row level security;
do $$
declare t text;
begin
  foreach t in array array['payroll_settings', 'pay_rules', 'pay_rule_versions', 'payroll_periods', 'payroll_entries', 'payroll_adjustments', 'payroll_exports'] loop
    execute format('create policy %I on public.%I for select to authenticated using (company_id = (select private.current_company_id()) and (select private.has_permission(''payroll.manage'')))', t || '_read', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('revoke insert, update, delete on public.%I from authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end $$;

-- -----------------------------------------------------------------------------
-- Helpers
-- -----------------------------------------------------------------------------
create or replace function private.payroll_company()
 returns uuid
 language plpgsql
 set search_path to ''
as $$
declare v uuid := private.require_company();
begin
  perform private.require_permission('payroll.manage');
  return v;
end;
$$;
revoke all on function private.payroll_company() from public, anon, authenticated;

-- The business date of a delivery in the company's time zone.
create or replace function private.ticket_business_date(p_company uuid, p_at timestamptz)
 returns date
 language sql
 stable
 set search_path to ''
as $$
  select (p_at at time zone coalesce((select s.timezone from public.company_settings s where s.company_id = p_company), 'America/Chicago'))::date;
$$;
revoke all on function private.ticket_business_date(uuid, timestamptz) from public, anon, authenticated;

create or replace function private.payroll_open_period(p_company uuid, p_period uuid)
 returns public.payroll_periods
 language plpgsql
 set search_path to ''
as $$
declare v public.payroll_periods%rowtype;
begin
  select * into v from public.payroll_periods where id = p_period and company_id = p_company for update;
  if not found then raise exception 'Payroll period not found.' using errcode = 'P0002'; end if;
  if v.status not in ('open', 'in_review') then
    raise exception 'This payroll period is % and locked. Corrections go into a later period as adjustments.', v.status using errcode = 'P0001';
  end if;
  return v;
end;
$$;
revoke all on function private.payroll_open_period(uuid, uuid) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Settings and rules
-- -----------------------------------------------------------------------------
create or replace function public.payroll_settings_save(p jsonb)
 returns void
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  v_company uuid := private.payroll_company();
  v_before  jsonb;
  v_len     text := nullif(p ->> 'period_length', '');
begin
  select to_jsonb(s) into v_before from public.payroll_settings s where s.company_id = v_company;
  if (p ->> 'enabled')::boolean and not exists (select 1 from public.pay_rule_versions where company_id = v_company and status = 'active') then
    raise exception 'Activate at least one pay rule before turning on payroll calculation.' using errcode = 'P0001';
  end if;
  insert into public.payroll_settings (company_id, enabled, period_length, period_anchor, updated_by, updated_at)
  values (v_company, coalesce((p ->> 'enabled')::boolean, false), v_len, nullif(p ->> 'period_anchor', '')::date, auth.uid(), now())
  on conflict (company_id) do update set enabled = excluded.enabled, period_length = excluded.period_length,
    period_anchor = excluded.period_anchor, updated_by = excluded.updated_by, updated_at = now();
  perform private.log_event('payroll.settings_changed', 'payroll_settings', v_company, 'Payroll settings changed',
    jsonb_build_object('before', v_before, 'after', p));
end;
$$;

/** Create a rule (with its first draft version) or a new draft version of an existing rule. */
create or replace function public.payroll_rule_draft(p jsonb)
 returns uuid
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  v_company uuid := private.payroll_company();
  v_rule    uuid := nullif(p ->> 'rule_id', '')::uuid;
  v_version integer;
  v_id      uuid;
  v_scope   jsonb := coalesce(p -> 'scope', '{}'::jsonb);
  k text;
begin
  for k in select jsonb_object_keys(v_scope) loop
    if k not in ('driver_id', 'customer_id', 'order_id', 'material_id', 'truck_id') then
      raise exception 'Unknown rule scope: %.', k using errcode = '22023';
    end if;
  end loop;
  if v_scope ? 'driver_id' and not exists (select 1 from public.drivers where id = (v_scope ->> 'driver_id')::uuid and company_id = v_company)
     or v_scope ? 'customer_id' and not exists (select 1 from public.customers where id = (v_scope ->> 'customer_id')::uuid and company_id = v_company)
     or v_scope ? 'order_id' and not exists (select 1 from public.orders where id = (v_scope ->> 'order_id')::uuid and company_id = v_company)
     or v_scope ? 'material_id' and not exists (select 1 from public.materials where id = (v_scope ->> 'material_id')::uuid and company_id = v_company)
     or v_scope ? 'truck_id' and not exists (select 1 from public.trucks where id = (v_scope ->> 'truck_id')::uuid and company_id = v_company) then
    raise exception 'The rule''s scope names a record that is not in this company.' using errcode = 'P0002';
  end if;
  if v_rule is null then
    insert into public.pay_rules (company_id, name, created_by) values (v_company, private.clean_text(p ->> 'name', 80, 'Rule name'), auth.uid())
    returning id into v_rule;
  elsif not exists (select 1 from public.pay_rules where id = v_rule and company_id = v_company) then
    raise exception 'Pay rule not found.' using errcode = 'P0002';
  end if;
  select coalesce(max(version), 0) + 1 into v_version from public.pay_rule_versions where rule_id = v_rule;
  insert into public.pay_rule_versions (company_id, rule_id, version, formula, rate, unit_code, scope, effective_from, effective_to, evidence_note, created_by)
  values (v_company, v_rule, v_version, trim(p ->> 'formula'), nullif(p ->> 'rate', '')::numeric, nullif(p ->> 'unit_code', ''), v_scope,
          (p ->> 'effective_from')::date, nullif(p ->> 'effective_to', '')::date, coalesce(p ->> 'evidence_note', ''), auth.uid())
  returning id into v_id;
  perform private.log_event('payroll.rule_drafted', 'pay_rule_version', v_id, 'Pay rule version ' || v_version || ' drafted',
    jsonb_build_object('rule_id', v_rule, 'formula', p ->> 'formula', 'rate', p ->> 'rate', 'scope', v_scope, 'effective_from', p ->> 'effective_from'));
  return v_id;
end;
$$;

/** Approve and activate a draft version. Refused when another active version of the same scope overlaps its dates. */
create or replace function public.payroll_rule_activate(p_version uuid, p_note text)
 returns void
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  v_company uuid := private.payroll_company();
  v public.pay_rule_versions%rowtype;
begin
  select * into v from public.pay_rule_versions where id = p_version and company_id = v_company for update;
  if not found then raise exception 'Pay rule version not found.' using errcode = 'P0002'; end if;
  if v.status <> 'draft' then raise exception 'Only a draft can be activated; this version is %.', v.status using errcode = 'P0001'; end if;
  if exists (select 1 from public.pay_rule_versions o
             where o.company_id = v_company and o.status = 'active' and o.id <> v.id
               and coalesce(o.unit_code, '') = coalesce(v.unit_code, '') and o.scope = v.scope
               and o.effective_from <= coalesce(v.effective_to, 'infinity'::date) and v.effective_from <= coalesce(o.effective_to, 'infinity'::date)) then
    raise exception 'Another active rule covers the same tickets in these dates. End it (set its last day) first, so only one rule applies.' using errcode = 'P0001';
  end if;
  update public.pay_rule_versions set status = 'active', approved_by = auth.uid(), approved_at = now() where id = v.id;
  perform private.log_event('payroll.rule_activated', 'pay_rule_version', v.id, 'Pay rule version ' || v.version || ' approved and activated',
    jsonb_build_object('rule_id', v.rule_id, 'formula', v.formula, 'rate', v.rate, 'scope', v.scope, 'effective_from', v.effective_from, 'note', left(coalesce(p_note, ''), 500)));
end;
$$;

/** End an active version on a date (its earlier tickets keep it), or retire a draft/active version. */
create or replace function public.payroll_rule_end(p_version uuid, p_last_day date)
 returns void
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  v_company uuid := private.payroll_company();
  v public.pay_rule_versions%rowtype;
begin
  select * into v from public.pay_rule_versions where id = p_version and company_id = v_company for update;
  if not found then raise exception 'Pay rule version not found.' using errcode = 'P0002'; end if;
  if p_last_day is null then
    if exists (select 1 from public.payroll_entries e where e.rule_version_id = v.id and e.status = 'calculated') then
      raise exception 'Earnings were calculated with this version; set its last day instead so history stays reproducible.' using errcode = 'P0001';
    end if;
    update public.pay_rule_versions set status = 'retired' where id = v.id and status <> 'retired';
  else
    if p_last_day < v.effective_from then raise exception 'The last day cannot be before the first day.' using errcode = '22023'; end if;
    if exists (select 1 from public.payroll_entries e join public.delivery_tickets t on t.id = e.ticket_id
               where e.rule_version_id = v.id and e.status = 'calculated' and private.ticket_business_date(v_company, t.delivered_at) > p_last_day) then
      raise exception 'Earnings after that day were already calculated with this version.' using errcode = 'P0001';
    end if;
    update public.pay_rule_versions set effective_to = p_last_day where id = v.id;
  end if;
  perform private.log_event('payroll.rule_ended', 'pay_rule_version', v.id, 'Pay rule version ' || v.version || ' ended',
    jsonb_build_object('last_day', p_last_day, 'before_effective_to', v.effective_to));
end;
$$;

-- -----------------------------------------------------------------------------
-- Periods and the ticket ledger
-- -----------------------------------------------------------------------------
create or replace function public.payroll_period_create(p_starts date, p_ends date)
 returns uuid
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  v_company uuid := private.payroll_company();
  v_id uuid;
begin
  if p_starts is null or p_ends is null or p_ends < p_starts or p_ends - p_starts > 62 then
    raise exception 'Choose a period of at most 63 days.' using errcode = '22023';
  end if;
  if exists (select 1 from public.payroll_periods where company_id = v_company and starts_on <= p_ends and p_starts <= ends_on) then
    raise exception 'This period overlaps another payroll period.' using errcode = 'P0001';
  end if;
  insert into public.payroll_periods (company_id, starts_on, ends_on, created_by) values (v_company, p_starts, p_ends, auth.uid()) returning id into v_id;
  perform private.log_event('payroll.period_created', 'payroll_period', v_id, 'Payroll period ' || p_starts || ' to ' || p_ends || ' created', '{}'::jsonb);
  return v_id;
end;
$$;

/**
 * What a period's tickets look like for payroll: payable tickets not yet in the ledger (with the facts a rule is chosen
 * by and the quantity), tickets that cannot be paid yet and why, and corrections — tickets paid in an approved period
 * that were corrected or voided since (to settle with an adjustment).
 */
create or replace function public.payroll_period_work(p_period uuid)
 returns jsonb
 language plpgsql
 stable
 security definer
 set search_path to ''
as $$
declare
  v_company uuid := private.payroll_company();
  v public.payroll_periods%rowtype;
begin
  select * into v from public.payroll_periods where id = p_period and company_id = v_company;
  if not found then raise exception 'Payroll period not found.' using errcode = 'P0002'; end if;
  return jsonb_build_object(
    'payable', (select coalesce(jsonb_agg(jsonb_build_object(
        'ticket_id', t.id, 'ticket_number', t.ticket_number, 'revision', t.revision, 'driver_id', t.driver_id,
        'delivered_on', private.ticket_business_date(v_company, t.delivered_at), 'quantity', t.quantity, 'unit_code', t.unit_code,
        'order_id', t.order_id, 'order_line_id', t.order_line_id, 'customer_id', o.customer_id, 'material_id', t.material_id, 'truck_id', t.truck_id) order by t.delivered_at), '[]')
      from public.delivery_tickets t join public.orders o on o.id = t.order_id and o.company_id = t.company_id
      where t.company_id = v_company and t.status = 'accepted' and t.driver_id is not null
        and private.ticket_business_date(v_company, t.delivered_at) between v.starts_on and v.ends_on
        and not exists (select 1 from public.payroll_entries e where e.ticket_id = t.id and e.driver_id = t.driver_id and e.status <> 'reversed')),
    'not_payable', (select coalesce(jsonb_agg(jsonb_build_object(
        'ticket_id', t.id, 'ticket_number', t.ticket_number, 'status', t.status, 'driver_id', t.driver_id,
        'reason', case when t.driver_id is null then 'no_driver' else 'not_verified' end) order by t.delivered_at), '[]')
      from public.delivery_tickets t
      where t.company_id = v_company and private.ticket_business_date(v_company, t.delivered_at) between v.starts_on and v.ends_on
        and (t.status in ('submitted', 'needs_review') or (t.status = 'accepted' and t.driver_id is null))),
    'corrections', (select coalesce(jsonb_agg(jsonb_build_object(
        'entry_id', e.id, 'ticket_id', t.id, 'ticket_number', t.ticket_number, 'ticket_status', t.status, 'driver_id', e.driver_id,
        'amount_cents', e.amount_cents, 'paid_in', p.starts_on)), '[]')
      from public.payroll_entries e join public.delivery_tickets t on t.id = e.ticket_id join public.payroll_periods p on p.id = e.period_id
      where e.company_id = v_company and e.status = 'calculated' and p.status in ('approved', 'exported', 'reconciled')
        and t.status in ('voided', 'superseded')
        and not exists (select 1 from public.payroll_adjustments a where a.entry_id = e.id)));
end;
$$;

/**
 * Record calculated earnings or exceptions for tickets (the formula engine runs on the server; the database checks
 * everything it can: permission, company, open period, the ticket is payable, in the period and the driver's own, the
 * rule version is active on the delivery date). A ticket already in the ledger is skipped (idempotent retries).
 */
create or replace function public.payroll_record_entries(p_period uuid, p_entries jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  v_company uuid := private.payroll_company();
  v_period public.payroll_periods%rowtype := private.payroll_open_period(v_company, p_period);
  v_enabled boolean := coalesce((select enabled from public.payroll_settings where company_id = v_company), false);
  e jsonb;
  t public.delivery_tickets%rowtype;
  r public.pay_rule_versions%rowtype;
  v_day date;
  v_status text;
  v_added int := 0;
  v_skipped int := 0;
begin
  if jsonb_typeof(p_entries) <> 'array' or jsonb_array_length(p_entries) > 2000 then
    raise exception 'Send at most 2000 entries at a time.' using errcode = '22023';
  end if;
  for e in select * from jsonb_array_elements(p_entries) loop
    v_status := e ->> 'status';
    if v_status not in ('calculated', 'exception') then raise exception 'Unknown entry status.' using errcode = '22023'; end if;
    if v_status = 'calculated' and not v_enabled then
      raise exception 'Payroll calculation is not turned on for this company. Preview only until a confirmed rule is active and calculation is enabled.' using errcode = 'P0001';
    end if;
    select * into t from public.delivery_tickets where id = (e ->> 'ticket_id')::uuid and company_id = v_company;
    if not found then raise exception 'Ticket not found.' using errcode = 'P0002'; end if;
    if t.status <> 'accepted' then raise exception 'Ticket % is not verified (accepted) and cannot be paid.', t.ticket_number using errcode = 'P0001'; end if;
    if t.driver_id is null or t.driver_id <> (e ->> 'driver_id')::uuid then
      raise exception 'Ticket % is not this driver''s.', t.ticket_number using errcode = 'P0001';
    end if;
    v_day := private.ticket_business_date(v_company, t.delivered_at);
    if v_day not between v_period.starts_on and v_period.ends_on then
      raise exception 'Ticket % was delivered outside this period.', t.ticket_number using errcode = 'P0001';
    end if;
    if v_status = 'calculated' then
      select * into r from public.pay_rule_versions where id = (e ->> 'rule_version_id')::uuid and company_id = v_company;
      if not found or r.status <> 'active' or r.effective_from > v_day or (r.effective_to is not null and r.effective_to < v_day) then
        raise exception 'The pay rule used for ticket % is not active on its delivery date.', t.ticket_number using errcode = 'P0001';
      end if;
      if (e ->> 'amount_cents') is null then raise exception 'A calculated entry needs an amount.' using errcode = '22023'; end if;
    end if;
    begin
      insert into public.payroll_entries (company_id, period_id, ticket_id, driver_id, rule_version_id, status, inputs, breakdown, amount_cents, exception, calculated_by)
      values (v_company, p_period, t.id, t.driver_id, case when v_status = 'calculated' then r.id end, v_status,
              coalesce(e -> 'inputs', '{}'::jsonb), left(coalesce(e ->> 'breakdown', ''), 2000),
              case when v_status = 'calculated' then (e ->> 'amount_cents')::bigint end, left(coalesce(e ->> 'exception', ''), 300), auth.uid());
      v_added := v_added + 1;
    exception when unique_violation then
      v_skipped := v_skipped + 1; -- already in the ledger: never paid twice
    end;
  end loop;
  perform private.log_event('payroll.entries_recorded', 'payroll_period', p_period, v_added || ' payroll entries recorded',
    jsonb_build_object('added', v_added, 'already_recorded', v_skipped));
  return jsonb_build_object('added', v_added, 'already_recorded', v_skipped);
end;
$$;

/** Reverse an entry in an open period (kept in history), or exclude an exception with a reason. */
create or replace function public.payroll_entry_set(p_entry uuid, p_status text, p_note text)
 returns void
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  v_company uuid := private.payroll_company();
  v public.payroll_entries%rowtype;
begin
  select * into v from public.payroll_entries where id = p_entry and company_id = v_company for update;
  if not found then raise exception 'Payroll entry not found.' using errcode = 'P0002'; end if;
  perform private.payroll_open_period(v_company, v.period_id);
  if length(trim(coalesce(p_note, ''))) < 3 then raise exception 'Give a reason.' using errcode = '22023'; end if;
  if not ((p_status = 'reversed' and v.status in ('calculated', 'exception', 'excluded')) or (p_status = 'excluded' and v.status = 'exception')) then
    raise exception 'That change is not allowed for this entry.' using errcode = 'P0001';
  end if;
  update public.payroll_entries set status = p_status, note = left(p_note, 500), changed_by = auth.uid(), changed_at = now() where id = v.id;
  perform private.log_event('payroll.entry_' || p_status, 'payroll_entry', v.id, 'Payroll entry ' || p_status,
    jsonb_build_object('ticket_id', v.ticket_id, 'driver_id', v.driver_id, 'amount_cents', v.amount_cents, 'reason', p_note));
end;
$$;

create or replace function public.payroll_adjust(p_period uuid, p_driver uuid, p_amount_cents bigint, p_reason text, p_entry uuid)
 returns uuid
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  v_company uuid := private.payroll_company();
  v_id uuid;
begin
  perform private.payroll_open_period(v_company, p_period);
  if not exists (select 1 from public.drivers where id = p_driver and company_id = v_company) then
    raise exception 'Driver not found.' using errcode = 'P0002';
  end if;
  if p_entry is not null and not exists (select 1 from public.payroll_entries where id = p_entry and company_id = v_company and driver_id = p_driver) then
    raise exception 'Payroll entry not found.' using errcode = 'P0002';
  end if;
  insert into public.payroll_adjustments (company_id, period_id, driver_id, entry_id, amount_cents, reason, created_by)
  values (v_company, p_period, p_driver, p_entry, p_amount_cents, trim(p_reason), auth.uid()) returning id into v_id;
  perform private.log_event('payroll.adjustment', 'payroll_period', p_period, 'Payroll adjustment recorded',
    jsonb_build_object('driver_id', p_driver, 'amount_cents', p_amount_cents, 'reason', p_reason, 'entry_id', p_entry));
  return v_id;
end;
$$;

/** Approve and lock a period: refused while exceptions are unresolved. Stores the totals that were approved. */
create or replace function public.payroll_period_approve(p_period uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  v_company uuid := private.payroll_company();
  v public.payroll_periods%rowtype := private.payroll_open_period(v_company, p_period);
  v_totals jsonb;
  v_open int;
begin
  select count(*) into v_open from public.payroll_entries where period_id = v.id and status = 'exception';
  if v_open > 0 then
    raise exception '% ticket% still need review (exceptions). Resolve or exclude them first.', v_open, case when v_open = 1 then '' else 's' end using errcode = 'P0001';
  end if;
  select jsonb_build_object(
    'drivers', (select coalesce(jsonb_agg(x order by x ->> 'driver_id'), '[]') from (
      select jsonb_build_object('driver_id', d.id, 'tickets', coalesce(en.n, 0), 'earnings_cents', coalesce(en.s, 0), 'adjustments_cents', coalesce(ad.s, 0),
                                'total_cents', coalesce(en.s, 0) + coalesce(ad.s, 0)) as x
      from public.drivers d
      left join (select driver_id, count(*) n, sum(amount_cents) s from public.payroll_entries where period_id = v.id and status = 'calculated' group by driver_id) en on en.driver_id = d.id
      left join (select driver_id, sum(amount_cents) s from public.payroll_adjustments where period_id = v.id group by driver_id) ad on ad.driver_id = d.id
      where d.company_id = v_company and (en.n is not null or ad.s is not null)) q),
    'total_cents', coalesce((select sum(amount_cents) from public.payroll_entries where period_id = v.id and status = 'calculated'), 0)
                 + coalesce((select sum(amount_cents) from public.payroll_adjustments where period_id = v.id), 0))
  into v_totals;
  update public.payroll_periods set status = 'approved', totals = v_totals, approved_by = auth.uid(), approved_at = now() where id = v.id;
  perform private.log_event('payroll.period_approved', 'payroll_period', v.id, 'Payroll period ' || v.starts_on || ' to ' || v.ends_on || ' approved and locked', v_totals);
  return v_totals;
end;
$$;

/** Record a prepared export (idempotent by content: the same file is the same export). */
create or replace function public.payroll_export_record(p_period uuid, p_format text, p_hash text, p_rows integer, p_total_cents bigint)
 returns uuid
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  v_company uuid := private.payroll_company();
  v public.payroll_periods%rowtype;
  v_id uuid;
begin
  select * into v from public.payroll_periods where id = p_period and company_id = v_company for update;
  if not found then raise exception 'Payroll period not found.' using errcode = 'P0002'; end if;
  if v.status not in ('approved', 'exported', 'reconciled') then
    raise exception 'Approve the period before exporting it.' using errcode = 'P0001';
  end if;
  if p_total_cents <> (v.totals ->> 'total_cents')::bigint then
    raise exception 'The export total does not match the approved total.' using errcode = 'P0001';
  end if;
  select id into v_id from public.payroll_exports where period_id = p_period and format = p_format and content_hash = p_hash;
  if v_id is not null then return v_id; end if;
  insert into public.payroll_exports (company_id, period_id, format, content_hash, row_count, total_cents, created_by)
  values (v_company, p_period, p_format, p_hash, p_rows, p_total_cents, auth.uid()) returning id into v_id;
  update public.payroll_periods set status = 'exported' where id = p_period and status = 'approved';
  perform private.log_event('payroll.exported', 'payroll_period', p_period, 'Payroll export prepared (' || p_format || ')',
    jsonb_build_object('export_id', v_id, 'rows', p_rows, 'total_cents', p_total_cents));
  return v_id;
end;
$$;

/** Record what the payroll destination did with an export, and reconcile the period. */
create or replace function public.payroll_export_outcome(p_export uuid, p_status text, p_reference text, p_note text)
 returns void
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  v_company uuid := private.payroll_company();
  v public.payroll_exports%rowtype;
begin
  select * into v from public.payroll_exports where id = p_export and company_id = v_company for update;
  if not found then raise exception 'Export not found.' using errcode = 'P0002'; end if;
  if p_status not in ('accepted', 'rejected', 'failed') then raise exception 'Unknown outcome.' using errcode = '22023'; end if;
  update public.payroll_exports set status = p_status, reference = left(coalesce(p_reference, ''), 120), note = left(coalesce(p_note, ''), 1000),
         decided_by = auth.uid(), decided_at = now() where id = v.id;
  if p_status = 'accepted' then
    update public.payroll_periods set status = 'reconciled', reconciled_note = left(coalesce(p_note, ''), 1000) where id = v.period_id;
  end if;
  perform private.log_event('payroll.export_' || p_status, 'payroll_period', v.period_id, 'Payroll export ' || p_status,
    jsonb_build_object('export_id', v.id, 'reference', p_reference, 'note', p_note));
end;
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.payroll_settings_save(jsonb)', 'public.payroll_rule_draft(jsonb)', 'public.payroll_rule_activate(uuid, text)',
    'public.payroll_rule_end(uuid, date)', 'public.payroll_period_create(date, date)', 'public.payroll_period_work(uuid)',
    'public.payroll_record_entries(uuid, jsonb)', 'public.payroll_entry_set(uuid, text, text)',
    'public.payroll_adjust(uuid, uuid, bigint, text, uuid)', 'public.payroll_period_approve(uuid)',
    'public.payroll_export_record(uuid, text, text, integer, bigint)', 'public.payroll_export_outcome(uuid, text, text, text)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
