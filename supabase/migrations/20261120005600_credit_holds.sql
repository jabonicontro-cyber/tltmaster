-- B128 credit holds (owner 2026-11-02: warn, and a reason to proceed). A customer is on credit hold when billing put
-- them on hold by hand, or — when the company turns the rules on — an issued invoice is past due by more than the set
-- number of days, or the open balance is over the customer's credit limit. Creating an order or dispatching a load for
-- them is never blocked: the person sees the hold and records a reason, kept in credit_hold_overrides. Billing releases
-- a manual hold. Non-destructive: new columns, tables and functions only.

alter table public.customers
  add column credit_hold boolean not null default false,
  add column credit_hold_reason text not null default '' check (length(credit_hold_reason) <= 500),
  add column credit_hold_at timestamptz,
  add column credit_hold_by uuid references auth.users (id) on delete set null,
  add column credit_limit_cents bigint check (credit_limit_cents is null or credit_limit_cents between 0 and 100000000000);

create table public.credit_hold_settings (
  company_id    uuid primary key references public.companies (id) on delete cascade,
  -- Days past the due date after which an unpaid issued invoice puts the customer on hold; null = rule off.
  overdue_days  integer check (overdue_days is null or overdue_days between 0 and 365),
  updated_by    uuid references auth.users (id) on delete set null,
  updated_at    timestamptz not null default now()
);
alter table public.credit_hold_settings enable row level security;
create policy credit_hold_settings_read on public.credit_hold_settings for select to authenticated
  using (company_id = (select private.current_company_id()));
revoke all on public.credit_hold_settings from anon;
grant select on public.credit_hold_settings to authenticated;

create table public.credit_hold_overrides (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies (id) on delete cascade,
  customer_id  uuid not null references public.customers (id) on delete cascade,
  context      text not null check (context in ('order', 'assignment')),
  entity_id    uuid,
  reason       text not null check (length(reason) between 1 and 500),
  hold_reasons text[] not null default '{}',
  created_by   uuid references auth.users (id) on delete set null,
  created_at   timestamptz not null default now()
);
create index credit_hold_overrides_customer on public.credit_hold_overrides (company_id, customer_id, created_at desc);
alter table public.credit_hold_overrides enable row level security;
create policy credit_hold_overrides_read on public.credit_hold_overrides for select to authenticated
  using (company_id = (select private.current_company_id()) and (select private.has_permission('billing.view')));
revoke all on public.credit_hold_overrides from anon;
grant select on public.credit_hold_overrides to authenticated;

-- Why each customer is on hold right now (only customers with at least one reason). Amounts are open balances of issued
-- invoices (total minus payments not voided).
create or replace function private.credit_holds(p_company uuid, p_customers uuid[] default null)
returns table (customer_id uuid, reasons text[], open_cents bigint, oldest_overdue_days integer)
language sql
stable
security definer
set search_path = ''
as $$
  with s as (select overdue_days from public.credit_hold_settings where company_id = p_company),
  bal as (
    select i.customer_id,
           sum(i.total_cents - coalesce((select sum(p.amount_cents) from public.invoice_payments p where p.company_id = i.company_id and p.invoice_id = i.id and p.voided_at is null), 0)) as open_cents,
           max(case when i.due_date is not null and i.total_cents > coalesce((select sum(p.amount_cents) from public.invoice_payments p where p.company_id = i.company_id and p.invoice_id = i.id and p.voided_at is null), 0)
                    then private.company_today(p_company) - i.due_date end) as oldest
    from public.invoices i
    where i.company_id = p_company and i.status = 'issued' and (p_customers is null or i.customer_id = any (p_customers))
    group by i.customer_id
  )
  select c.id,
         array_remove(array[
           case when c.credit_hold then 'manual' end,
           case when (select overdue_days from s) is not null and coalesce(b.oldest, -1) > (select overdue_days from s) then 'overdue' end,
           case when c.credit_limit_cents is not null and coalesce(b.open_cents, 0) > c.credit_limit_cents then 'over_limit' end
         ], null),
         coalesce(b.open_cents, 0)::bigint,
         greatest(coalesce(b.oldest, 0), 0)::integer
  from public.customers c left join bal b on b.customer_id = c.id
  where c.company_id = p_company and (p_customers is null or c.id = any (p_customers))
    and (c.credit_hold
         or ((select overdue_days from s) is not null and coalesce(b.oldest, -1) > (select overdue_days from s))
         or (c.credit_limit_cents is not null and coalesce(b.open_cents, 0) > c.credit_limit_cents));
$$;
revoke all on function private.credit_holds(uuid, uuid[]) from public, anon, authenticated;

-- Staff who create orders or dispatch see holds (no amounts unless they may see billing).
create or replace function public.customer_credit_holds(p_customers uuid[] default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v_money boolean := private.has_permission('billing.view');
begin
  if not (private.has_permission('orders.view') or private.has_permission('dispatch.view') or private.has_permission('customers.view')) then
    raise exception 'Not allowed.' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('customer_id', h.customer_id, 'name', c.name, 'reasons', to_jsonb(h.reasons),
             'note', c.credit_hold_reason,
             'open_cents', case when v_money then h.open_cents end,
             'credit_limit_cents', case when v_money then c.credit_limit_cents end,
             'oldest_overdue_days', case when v_money then h.oldest_overdue_days end) order by c.name)
    from private.credit_holds(v_company, p_customers) h join public.customers c on c.id = h.customer_id), '[]'::jsonb);
end;
$$;

-- Billing: put a customer on hold (reason required) or release a manual hold.
create or replace function public.set_customer_credit_hold(p_customer uuid, p_hold boolean, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v_reason text := private.clean_text(p_reason, 500, 'Reason');
  v_name text;
begin
  perform private.require_permission('billing.manage');
  if coalesce(p_hold, false) and length(v_reason) = 0 then
    raise exception 'Say why the customer is on hold.' using errcode = '22023';
  end if;
  update public.customers set credit_hold = coalesce(p_hold, false),
    credit_hold_reason = case when coalesce(p_hold, false) then v_reason else '' end,
    credit_hold_at = case when coalesce(p_hold, false) then now() end,
    credit_hold_by = case when coalesce(p_hold, false) then auth.uid() end
  where id = p_customer and company_id = v_company
  returning name into v_name;
  if v_name is null then
    raise exception 'Customer not found.' using errcode = 'P0002';
  end if;
  perform private.log_event(case when coalesce(p_hold, false) then 'customer.credit_hold' else 'customer.credit_release' end, 'customer', p_customer,
    format('%s %s', v_name, case when coalesce(p_hold, false) then 'put on credit hold' else 'released from credit hold' end),
    jsonb_build_object('reason', v_reason));
end;
$$;

create or replace function public.set_customer_credit_limit(p_customer uuid, p_limit_cents bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v_name text;
begin
  perform private.require_permission('billing.manage');
  if p_limit_cents is not null and (p_limit_cents < 0 or p_limit_cents > 100000000000) then
    raise exception 'Enter a credit limit between $0 and $1,000,000,000.' using errcode = '22023';
  end if;
  update public.customers set credit_limit_cents = p_limit_cents where id = p_customer and company_id = v_company returning name into v_name;
  if v_name is null then
    raise exception 'Customer not found.' using errcode = 'P0002';
  end if;
  perform private.log_event('customer.credit_limit', 'customer', p_customer, format('Credit limit for %s set', v_name), jsonb_build_object('limit_cents', p_limit_cents));
end;
$$;

create or replace function public.credit_hold_save_settings(p_overdue_days integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
begin
  perform private.require_permission('billing.manage');
  if p_overdue_days is not null and p_overdue_days not between 0 and 365 then
    raise exception 'Choose between 0 and 365 days.' using errcode = '22023';
  end if;
  insert into public.credit_hold_settings (company_id, overdue_days, updated_by, updated_at) values (v_company, p_overdue_days, auth.uid(), now())
  on conflict (company_id) do update set overdue_days = excluded.overdue_days, updated_by = excluded.updated_by, updated_at = excluded.updated_at;
  perform private.log_event('credit_hold.settings_saved', 'credit_hold_settings', v_company,
    case when p_overdue_days is null then 'Automatic credit holds for overdue invoices turned off' else format('Customers go on credit hold %s days past due', p_overdue_days) end,
    jsonb_build_object('overdue_days', p_overdue_days));
end;
$$;

-- Proceeding for a customer on hold: the person who creates the order or dispatches the load records why. Refused when
-- the customer is not on hold (nothing to override) or the person cannot create orders or dispatch.
create or replace function public.record_credit_override(p_customer uuid, p_context text, p_entity uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v_reason text := private.clean_text(p_reason, 500, 'Reason');
  v_reasons text[];
begin
  if p_context not in ('order', 'assignment') then
    raise exception 'Unknown context.' using errcode = '22023';
  end if;
  if not private.has_permission(case p_context when 'order' then 'orders.edit' else 'dispatch.edit' end) then
    raise exception 'Not allowed.' using errcode = '42501';
  end if;
  if length(v_reason) = 0 then
    raise exception 'Give a reason to go ahead for a customer on credit hold.' using errcode = '22023';
  end if;
  select h.reasons into v_reasons from private.credit_holds(v_company, array[p_customer]) h;
  if v_reasons is null then
    return; -- not on hold (any more): nothing to record
  end if;
  insert into public.credit_hold_overrides (company_id, customer_id, context, entity_id, reason, hold_reasons, created_by)
  values (v_company, p_customer, p_context, p_entity, v_reason, v_reasons, auth.uid());
  perform private.log_event('customer.credit_override', 'customer', p_customer,
    format('Went ahead with %s for a customer on credit hold: %s', case p_context when 'order' then 'an order' else 'a dispatch' end, v_reason),
    jsonb_build_object('context', p_context, 'entity_id', p_entity, 'hold_reasons', v_reasons));
end;
$$;

-- Demo sample: one customer on a manual hold, so orders and the board show the warning. Fictional; added once.
create or replace function public.demo_credit_hold_sample()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_demo uuid := private.demo_owner_company();
  v_id uuid;
begin
  if v_demo is null then
    raise exception 'Demo samples are only added to a demo company, by its owner.' using errcode = '42501';
  end if;
  if exists (select 1 from public.customers where company_id = v_demo and credit_hold) then
    return 0;
  end if;
  -- A customer with orders but not the priority one, so the two badges are shown on different customers.
  select o.customer_id into v_id from public.orders o join public.customers c on c.id = o.customer_id
  where o.company_id = v_demo and o.status not in ('draft', 'canceled') and c.active and not coalesce(c.is_priority, false)
  group by o.customer_id order by count(*) asc, o.customer_id limit 1;
  if v_id is null then
    return 0;
  end if;
  update public.customers set credit_hold = true, credit_hold_reason = 'Two invoices more than 60 days late (demo).', credit_hold_at = now(), credit_hold_by = auth.uid()
  where id = v_id and company_id = v_demo;
  return 1;
end;
$$;

revoke all on function public.customer_credit_holds(uuid[]) from public, anon;
revoke all on function public.set_customer_credit_hold(uuid, boolean, text) from public, anon;
revoke all on function public.set_customer_credit_limit(uuid, bigint) from public, anon;
revoke all on function public.credit_hold_save_settings(integer) from public, anon;
revoke all on function public.record_credit_override(uuid, text, uuid, text) from public, anon;
revoke all on function public.demo_credit_hold_sample() from public, anon;
grant execute on function public.customer_credit_holds(uuid[]) to authenticated;
grant execute on function public.set_customer_credit_hold(uuid, boolean, text) to authenticated;
grant execute on function public.set_customer_credit_limit(uuid, bigint) to authenticated;
grant execute on function public.credit_hold_save_settings(integer) to authenticated;
grant execute on function public.record_credit_override(uuid, text, uuid, text) to authenticated;
grant execute on function public.demo_credit_hold_sample() to authenticated;
