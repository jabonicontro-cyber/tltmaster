-- B129 hauler settlements (owner 2026-11-02: a commission percentage per hauler plus one-off deductions). A settlement
-- pays one hauler for a period: each confirmed hired job whose accepted tickets are all in the offer's unit, at the
-- offered rate (the same rule as the Hauler pay statement); commission and deductions come off the gross. Draft →
-- approved (locked) → paid (date and reference recorded; Taviron moves no money) or void (reason; its jobs are free
-- again). A job is in at most one settlement that is not void. Non-destructive: new columns, tables and functions.

alter table public.haulers add column commission_bp integer not null default 0 check (commission_bp between 0 and 5000);

create table public.hauler_settlements (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references public.companies (id),
  number           integer not null,
  hauler_id        uuid not null,
  period_start     date not null,
  period_end       date not null check (period_end >= period_start),
  status           text not null default 'draft' check (status in ('draft', 'approved', 'paid', 'void')),
  gross_cents      bigint not null default 0,
  commission_bp    integer not null default 0 check (commission_bp between 0 and 5000),
  commission_cents bigint not null default 0,
  deductions_cents bigint not null default 0,
  net_cents        bigint not null default 0,
  note             text not null default '' check (length(note) <= 500),
  paid_on          date,
  paid_reference   text not null default '' check (length(paid_reference) <= 80),
  void_reason      text not null default '' check (length(void_reason) <= 500),
  created_by       uuid references auth.users (id) on delete set null,
  created_at       timestamptz not null default now(),
  approved_by      uuid references auth.users (id) on delete set null,
  approved_at      timestamptz,
  paid_by          uuid references auth.users (id) on delete set null,
  unique (company_id, id),
  unique (company_id, number),
  foreign key (company_id, hauler_id) references public.haulers (company_id, id)
);

create table public.hauler_settlement_jobs (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies (id),
  settlement_id uuid not null,
  -- Sample-data removal takes a sample job's offer with it (on delete cascade); real offers are never deleted.
  offer_id      uuid not null references public.hauler_offers (id) on delete cascade,
  load_date     date not null,
  label         text not null,
  quantity      numeric(12, 3) not null,
  rate_unit     text not null,
  rate_cents    integer not null,
  amount_cents  bigint not null,
  released      boolean not null default false,
  foreign key (company_id, settlement_id) references public.hauler_settlements (company_id, id)
);
create unique index hauler_settlement_jobs_once on public.hauler_settlement_jobs (offer_id) where not released;

create table public.hauler_settlement_deductions (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies (id),
  settlement_id uuid not null,
  description   text not null check (length(trim(description)) between 1 and 200),
  amount_cents  bigint not null check (amount_cents > 0 and amount_cents <= 100000000),
  removed       boolean not null default false,
  created_by    uuid references auth.users (id) on delete set null,
  created_at    timestamptz not null default now(),
  foreign key (company_id, settlement_id) references public.hauler_settlements (company_id, id)
);

alter table public.hauler_settlements enable row level security;
alter table public.hauler_settlement_jobs enable row level security;
alter table public.hauler_settlement_deductions enable row level security;
create policy hauler_settlements_read on public.hauler_settlements for select to authenticated
  using (company_id = (select private.current_company_id()) and ((select private.has_permission('payroll.manage')) or (select private.has_permission('billing.view'))));
create policy hauler_settlement_jobs_read on public.hauler_settlement_jobs for select to authenticated
  using (company_id = (select private.current_company_id()) and ((select private.has_permission('payroll.manage')) or (select private.has_permission('billing.view'))));
create policy hauler_settlement_deductions_read on public.hauler_settlement_deductions for select to authenticated
  using (company_id = (select private.current_company_id()) and ((select private.has_permission('payroll.manage')) or (select private.has_permission('billing.view'))));
revoke all on public.hauler_settlements, public.hauler_settlement_jobs, public.hauler_settlement_deductions from anon;
grant select on public.hauler_settlements, public.hauler_settlement_jobs, public.hauler_settlement_deductions to authenticated;

-- Totals from the jobs and active deductions; the commission rate is the one frozen on the settlement.
create or replace function private.hauler_settlement_total(p_settlement uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_gross bigint;
  v_ded bigint;
  v_bp integer;
begin
  select coalesce(sum(amount_cents), 0) into v_gross from public.hauler_settlement_jobs where settlement_id = p_settlement and not released;
  select coalesce(sum(amount_cents), 0) into v_ded from public.hauler_settlement_deductions where settlement_id = p_settlement and not removed;
  select commission_bp into v_bp from public.hauler_settlements where id = p_settlement;
  update public.hauler_settlements
     set gross_cents = v_gross,
         commission_cents = round(v_gross * v_bp / 10000.0)::bigint,
         deductions_cents = v_ded,
         net_cents = v_gross - round(v_gross * v_bp / 10000.0)::bigint - v_ded
   where id = p_settlement;
end;
$$;
revoke all on function private.hauler_settlement_total(uuid) from public, anon, authenticated;

create or replace function private.hauler_settlement_draft(p_settlement uuid)
returns public.hauler_settlements
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  s public.hauler_settlements%rowtype;
begin
  perform private.require_permission('payroll.manage');
  select * into s from public.hauler_settlements where id = p_settlement and company_id = v_company for update;
  if not found then raise exception 'Settlement not found.' using errcode = 'P0002'; end if;
  return s;
end;
$$;
revoke all on function private.hauler_settlement_draft(uuid) from public, anon, authenticated;

-- A hauler's commission (0–50 %), taken off the gross of settlements created from now on.
create or replace function public.hauler_set_commission(p_hauler uuid, p_bp integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v_name text;
begin
  perform private.require_permission('payroll.manage');
  if p_bp is null or p_bp not between 0 and 5000 then
    raise exception 'Commission is 0 to 50%%.' using errcode = '22023';
  end if;
  update public.haulers set commission_bp = p_bp where id = p_hauler and company_id = v_company returning name into v_name;
  if v_name is null then raise exception 'Hauler not found.' using errcode = 'P0002'; end if;
  perform private.log_event('hauler.commission', 'hauler', p_hauler, format('Commission for %s set to %s%%', v_name, trim_scale(p_bp / 100.0)), jsonb_build_object('commission_bp', p_bp));
end;
$$;

-- Create a draft settlement for one hauler and period: every confirmed job in the period not yet in another settlement,
-- whose accepted tickets are all in the offer's unit. Jobs without accepted tickets, or with a ticket in another unit,
-- are left out and counted so the office can check them first.
create or replace function public.hauler_settlement_create(p_hauler uuid, p_from date, p_to date)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v_hauler public.haulers%rowtype;
  v_id uuid;
  v_number integer;
  v_added integer := 0;
  v_skipped integer := 0;
  r record;
begin
  perform private.require_permission('payroll.manage');
  if not private.hired_trucks_on(v_company) then
    raise exception 'Hired trucks are not on for this company.' using errcode = '42501';
  end if;
  select * into v_hauler from public.haulers where id = p_hauler and company_id = v_company;
  if not found then raise exception 'Hauler not found.' using errcode = 'P0002'; end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 62 then
    raise exception 'Choose a period of up to two months.' using errcode = '22023';
  end if;
  select coalesce(max(number), 0) + 1 into v_number from public.hauler_settlements where company_id = v_company;
  insert into public.hauler_settlements (company_id, number, hauler_id, period_start, period_end, commission_bp, created_by)
  values (v_company, v_number, p_hauler, p_from, p_to, v_hauler.commission_bp, auth.uid())
  returning id into v_id;
  for r in
    select o.id, o.rate_cents, o.rate_unit, l.load_date, format('%s load %s', ord.order_number, l.load_number) as label,
           (select count(*) from public.delivery_tickets t where t.assignment_id = o.assignment_id and t.status = 'accepted') as n,
           (select count(*) from public.delivery_tickets t where t.assignment_id = o.assignment_id and t.status = 'accepted' and t.unit_code <> o.rate_unit) as other_unit,
           (select coalesce(sum(t.quantity), 0) from public.delivery_tickets t where t.assignment_id = o.assignment_id and t.status = 'accepted') as qty
    from public.hauler_offers o
    join public.order_loads l on l.id = o.load_id
    join public.orders ord on ord.id = l.order_id
    where o.company_id = v_company and o.hauler_id = p_hauler and o.status = 'confirmed'
      and l.load_date between p_from and p_to
      and not exists (select 1 from public.hauler_settlement_jobs j where j.offer_id = o.id and not j.released)
    order by l.load_date, ord.order_number, l.load_number
  loop
    if r.n = 0 or r.other_unit > 0 then
      v_skipped := v_skipped + 1;
      continue;
    end if;
    insert into public.hauler_settlement_jobs (company_id, settlement_id, offer_id, load_date, label, quantity, rate_unit, rate_cents, amount_cents)
    values (v_company, v_id, r.id, r.load_date, r.label, round(r.qty, 3), r.rate_unit, r.rate_cents, round(round(r.qty, 3) * r.rate_cents)::bigint);
    v_added := v_added + 1;
  end loop;
  perform private.hauler_settlement_total(v_id);
  perform private.log_event('hauler.settlement_created', 'hauler_settlement', v_id,
    format('Settlement %s for %s (%s – %s): %s jobs', v_number, v_hauler.name, p_from, p_to, v_added), jsonb_build_object('jobs', v_added, 'left_out', v_skipped));
  return jsonb_build_object('id', v_id, 'number', v_number, 'jobs', v_added, 'left_out', v_skipped);
end;
$$;

create or replace function public.hauler_settlement_deduct(p_settlement uuid, p_description text, p_amount_cents bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.hauler_settlements%rowtype := private.hauler_settlement_draft(p_settlement);
  v_desc text := private.clean_text(p_description, 200, 'Description');
begin
  if s.status <> 'draft' then raise exception 'Only a draft settlement can change.' using errcode = '22023'; end if;
  if length(v_desc) = 0 then raise exception 'Say what the deduction is for.' using errcode = '22023'; end if;
  if p_amount_cents is null or p_amount_cents <= 0 or p_amount_cents > 100000000 then
    raise exception 'Enter an amount greater than $0.' using errcode = '22023';
  end if;
  insert into public.hauler_settlement_deductions (company_id, settlement_id, description, amount_cents, created_by)
  values (s.company_id, s.id, v_desc, p_amount_cents, auth.uid());
  perform private.hauler_settlement_total(s.id);
  perform private.log_event('hauler.settlement_deduction', 'hauler_settlement', s.id, format('Deduction on settlement %s: %s', s.number, v_desc), jsonb_build_object('amount_cents', p_amount_cents));
end;
$$;

create or replace function public.hauler_settlement_remove_deduction(p_deduction uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_settlement uuid;
  s public.hauler_settlements%rowtype;
begin
  select settlement_id into v_settlement from public.hauler_settlement_deductions where id = p_deduction and not removed;
  if v_settlement is null then raise exception 'Deduction not found.' using errcode = 'P0002'; end if;
  s := private.hauler_settlement_draft(v_settlement);
  if s.status <> 'draft' then raise exception 'Only a draft settlement can change.' using errcode = '22023'; end if;
  update public.hauler_settlement_deductions set removed = true where id = p_deduction;
  perform private.hauler_settlement_total(s.id);
  perform private.log_event('hauler.settlement_deduction_removed', 'hauler_settlement', s.id, format('Deduction removed from settlement %s', s.number), '{}'::jsonb);
end;
$$;

-- Approve (locks it), mark paid (after approval; Taviron records it, it moves no money), or void (draft or approved,
-- with a reason; its jobs can go on another settlement).
create or replace function public.hauler_settlement_set_status(p_settlement uuid, p_status text, p_paid_on date, p_reference text, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.hauler_settlements%rowtype := private.hauler_settlement_draft(p_settlement);
  v_reason text := private.clean_text(p_reason, 500, 'Reason');
begin
  if p_status = 'approved' then
    if s.status <> 'draft' then raise exception 'Only a draft can be approved.' using errcode = '22023'; end if;
    if s.net_cents < 0 then raise exception 'Deductions are more than the pay after commission.' using errcode = '22023'; end if;
    update public.hauler_settlements set status = 'approved', approved_by = auth.uid(), approved_at = now() where id = s.id;
  elsif p_status = 'paid' then
    if s.status <> 'approved' then raise exception 'Approve the settlement before marking it paid.' using errcode = '22023'; end if;
    if p_paid_on is null or p_paid_on > private.company_today(s.company_id) or p_paid_on < s.period_start then
      raise exception 'Enter the day it was paid (not in the future).' using errcode = '22023';
    end if;
    update public.hauler_settlements set status = 'paid', paid_on = p_paid_on, paid_reference = private.clean_text(p_reference, 80, 'Reference'), paid_by = auth.uid() where id = s.id;
  elsif p_status = 'void' then
    if s.status not in ('draft', 'approved') then raise exception 'A paid settlement cannot be voided.' using errcode = '22023'; end if;
    if length(v_reason) = 0 then raise exception 'Say why it is voided.' using errcode = '22023'; end if;
    update public.hauler_settlements set status = 'void', void_reason = v_reason where id = s.id;
    update public.hauler_settlement_jobs set released = true where settlement_id = s.id;
  else
    raise exception 'Unknown status.' using errcode = '22023';
  end if;
  perform private.log_event('hauler.settlement_' || p_status, 'hauler_settlement', s.id, format('Settlement %s %s', s.number, p_status),
    jsonb_build_object('net_cents', s.net_cents, 'paid_on', p_paid_on, 'reason', v_reason));
end;
$$;

revoke all on function public.hauler_set_commission(uuid, integer) from public, anon;
revoke all on function public.hauler_settlement_create(uuid, date, date) from public, anon;
revoke all on function public.hauler_settlement_deduct(uuid, text, bigint) from public, anon;
revoke all on function public.hauler_settlement_remove_deduction(uuid) from public, anon;
revoke all on function public.hauler_settlement_set_status(uuid, text, date, text, text) from public, anon;
grant execute on function public.hauler_set_commission(uuid, integer) to authenticated;
grant execute on function public.hauler_settlement_create(uuid, date, date) to authenticated;
grant execute on function public.hauler_settlement_deduct(uuid, text, bigint) to authenticated;
grant execute on function public.hauler_settlement_remove_deduction(uuid) to authenticated;
grant execute on function public.hauler_settlement_set_status(uuid, text, date, text, text) to authenticated;
