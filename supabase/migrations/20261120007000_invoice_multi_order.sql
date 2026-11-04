-- One invoice for several orders of the same customer (UX10, owner 2026-11-04). An invoice was made from one handed-off
-- order; it can now also be made from several handed-off orders of one customer, whose frozen handoff lines are listed
-- together (each line names its order) and whose totals add up. Nothing is issued, sent or exported by combining:
-- the result is a draft like any other invoice.
--   * invoice_orders lists every order an invoice bills (backfilled for existing invoices; kept by triggers). Its
--     unique index allows one active invoice per handed-off order, so an order can never be billed twice, whether
--     on its own or in a combined invoice. Voiding an invoice frees its orders.
--   * invoice_create_combined(handoffs) makes the draft; invoice_combine_candidates() lists the orders that can be
--     combined (handed off, not undone, not invoiced, not sent to QuickBooks).
--   * revenue_leaks: a voided invoice counts as replaced when each of its orders is on an active invoice again.
--   * Fix: a draft can be discarded (voided); the dates check applies to numbered invoices only.
-- Reversible: supabase/rollbacks/20261120007000_invoice_multi_order.down.sql.

-- Fix: "Discard draft" failed. A voided draft has no number and no issue or due date, but the check required dates on
-- every invoice that is not a draft. Dates are now required on every numbered invoice (issued, or issued then voided).
do $$
declare
  r record;
begin
  for r in select conname from pg_constraint
            where conrelid = 'public.invoices'::regclass and contype = 'c'
              and pg_get_constraintdef(oid) like '%status = ''draft''::text) OR ((issue_date IS NOT NULL) AND (due_date IS NOT NULL))%' loop
    execute format('alter table public.invoices drop constraint %I', r.conname);
  end loop;
end;
$$;
alter table public.invoices add constraint invoices_dates_when_numbered
  check (number is null or (issue_date is not null and due_date is not null));

create table public.invoice_orders (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references public.companies (id),
  invoice_id       uuid not null,
  handoff_order_id uuid not null references public.billing_handoff_orders (id) on delete cascade,
  order_id         uuid not null,
  order_number     text not null,
  position         integer not null check (position >= 1),
  total_cents      bigint not null default 0,
  active           boolean not null default true,
  created_at       timestamptz not null default now(),
  foreign key (company_id, invoice_id) references public.invoices (company_id, id) on delete cascade,
  foreign key (company_id, order_id) references public.orders (company_id, id) on delete cascade,
  unique (invoice_id, handoff_order_id)
);
-- One active invoice per handed-off order, alone or combined: no double invoicing.
create unique index invoice_orders_one_active on public.invoice_orders (handoff_order_id) where active;
create index invoice_orders_invoice_idx on public.invoice_orders (invoice_id);
create index invoice_orders_company_idx on public.invoice_orders (company_id, order_id);

alter table public.invoice_orders enable row level security;
revoke all on public.invoice_orders from anon, authenticated;
grant select on public.invoice_orders to authenticated;
create policy invoice_orders_read on public.invoice_orders for select to authenticated
  using (company_id = (select private.current_company_id()) and (select private.has_permission('billing.view')));

-- Existing invoices bill one order each.
insert into public.invoice_orders (company_id, invoice_id, handoff_order_id, order_id, order_number, position, total_cents, active, created_at)
select i.company_id, i.id, i.handoff_order_id, i.order_id, i.order_number, 1, i.total_cents, i.status <> 'void', i.created_at
  from public.invoices i
on conflict do nothing;

-- Every new invoice lists its own (first) order; an order already on an active invoice is refused.
create or replace function private.invoice_orders_on_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from public.invoice_orders o where o.handoff_order_id = new.handoff_order_id and o.active) then
    raise exception 'This order already has an invoice.' using errcode = '23505';
  end if;
  insert into public.invoice_orders (company_id, invoice_id, handoff_order_id, order_id, order_number, position, total_cents, active)
  values (new.company_id, new.id, new.handoff_order_id, new.order_id,
          coalesce((select o.order_number from public.orders o where o.id = new.order_id), new.order_number),
          1, new.total_cents, new.status <> 'void');
  return new;
end;
$$;
revoke all on function private.invoice_orders_on_insert() from public, anon, authenticated;
create trigger invoice_orders_on_insert after insert on public.invoices
  for each row execute function private.invoice_orders_on_insert();

-- A voided invoice frees its orders, so they can be invoiced again.
create or replace function private.invoice_orders_on_void()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'void' and old.status <> 'void' then
    update public.invoice_orders set active = false where invoice_id = new.id;
  end if;
  return new;
end;
$$;
revoke all on function private.invoice_orders_on_void() from public, anon, authenticated;
create trigger invoice_orders_on_void after update of status on public.invoices
  for each row execute function private.invoice_orders_on_void();

-- Orders that can go on an invoice: handed off, not undone, not on an active invoice, not sent to QuickBooks.
-- Runs with the caller's rights (RLS: company, billing.view).
create or replace function public.invoice_combine_candidates()
returns table (handoff_order_id uuid, order_id uuid, order_number text, customer_id uuid, customer_name text,
               customer_po text, project_name text, service_start date, service_end date, total_cents bigint, handed_off_at timestamptz)
language sql
stable
security invoker
set search_path = ''
as $$
  select h.id, h.order_id, h.snapshot -> 'order' ->> 'order_number', o.customer_id, c.name,
         coalesce(h.snapshot -> 'order' ->> 'customer_po', ''), coalesce(h.snapshot -> 'order' ->> 'project_name', ''),
         (h.snapshot -> 'order' ->> 'service_start')::date, (h.snapshot -> 'order' ->> 'service_end')::date,
         coalesce((h.snapshot -> 'order' ->> 'total_cents')::bigint, 0), b.created_at
    from public.billing_handoff_orders h
    join public.billing_handoffs b on b.id = h.handoff_id
    join public.orders o on o.id = h.order_id and o.company_id = h.company_id
    join public.customers c on c.id = o.customer_id and c.company_id = o.company_id
   where h.company_id = private.current_company_id() and h.reverted_at is null
     and not exists (select 1 from public.invoice_orders io where io.handoff_order_id = h.id and io.active)
     and not exists (select 1 from public.invoices i where i.handoff_order_id = h.id and i.status <> 'void')
     and not exists (select 1 from public.accounting_invoice_sends s where s.handoff_order_id = h.id and s.status = 'sent' and not s.simulated)
   order by c.name, (h.snapshot -> 'order' ->> 'service_start'), (h.snapshot -> 'order' ->> 'order_number');
$$;

-- One draft invoice for several handed-off orders of one customer. Lines keep their frozen handoff values; each line
-- names its order. Totals are the sums of the orders' totals. PO: the one PO, or each distinct PO listed.
create or replace function public.invoice_create_combined(p_handoffs uuid[])
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v_settings public.invoicing_settings%rowtype;
  v_ids uuid[];
  v_found integer;
  v_customers integer;
  v_bad text;
  c public.customers%rowtype;
  v_entity jsonb;
  v_first public.billing_handoff_orders%rowtype;
  v_lines jsonb := '[]'::jsonb;
  v_no integer := 0;
  v_pos integer := 0;
  v_numbers text[] := '{}';
  r record;
  l jsonb;
  v_id uuid;
begin
  perform private.require_permission('billing.manage');
  select * into v_settings from public.invoicing_settings where company_id = v_company;
  if coalesce(v_settings.issuer, 'quickbooks') <> 'taviron' then
    raise exception 'Your company issues invoices in QuickBooks. To issue them from Taviron, change it in Settings → Invoicing.' using errcode = '22023';
  end if;
  select array_agg(distinct x) into v_ids from unnest(coalesce(p_handoffs, '{}')) x where x is not null;
  if coalesce(cardinality(v_ids), 0) < 2 then
    raise exception 'Choose at least two orders to put on one invoice.' using errcode = '22023';
  end if;
  if cardinality(v_ids) > 100 then
    raise exception 'One invoice can bill up to 100 orders.' using errcode = '22023';
  end if;
  -- Lock the handoffs so two people cannot invoice the same order at once.
  perform 1 from public.billing_handoff_orders h where h.id = any (v_ids) and h.company_id = v_company order by h.id for update;
  select count(*) into v_found from public.billing_handoff_orders h where h.id = any (v_ids) and h.company_id = v_company;
  if v_found <> cardinality(v_ids) then
    raise exception 'Handed-off order not found.' using errcode = 'P0002';
  end if;
  select string_agg(h.snapshot -> 'order' ->> 'order_number', ', ') into v_bad
    from public.billing_handoff_orders h where h.id = any (v_ids) and h.reverted_at is not null;
  if v_bad is not null then
    raise exception 'The handoff of order % was undone. Hand it off again to invoice it.', v_bad using errcode = '22023';
  end if;
  select string_agg(h.snapshot -> 'order' ->> 'order_number', ', ') into v_bad
    from public.billing_handoff_orders h
   where h.id = any (v_ids)
     and (exists (select 1 from public.invoice_orders io where io.handoff_order_id = h.id and io.active)
          or exists (select 1 from public.invoices i where i.handoff_order_id = h.id and i.status <> 'void'));
  if v_bad is not null then
    raise exception 'Order % already has an invoice.', v_bad using errcode = '23505';
  end if;
  select string_agg(h.snapshot -> 'order' ->> 'order_number', ', ') into v_bad
    from public.billing_handoff_orders h
   where h.id = any (v_ids)
     and exists (select 1 from public.accounting_invoice_sends s where s.handoff_order_id = h.id and s.status = 'sent' and not s.simulated);
  if v_bad is not null then
    raise exception 'Order % was already sent to QuickBooks as an invoice.', v_bad using errcode = '23505';
  end if;
  select count(distinct o.customer_id) into v_customers
    from public.billing_handoff_orders h join public.orders o on o.id = h.order_id and o.company_id = h.company_id
   where h.id = any (v_ids);
  if v_customers <> 1 then
    raise exception 'One invoice bills one customer. Choose orders of the same customer.' using errcode = '22023';
  end if;

  for r in select h.*, (h.snapshot -> 'order') as o
             from public.billing_handoff_orders h
            where h.id = any (v_ids)
            order by (h.snapshot -> 'order' ->> 'service_start') nulls last, (h.snapshot -> 'order' ->> 'order_number') loop
    if v_pos = 0 then
      select * into v_first from public.billing_handoff_orders where id = r.id;
    end if;
    v_pos := v_pos + 1;
    v_numbers := v_numbers || (r.o ->> 'order_number');
    for l in select value from jsonb_array_elements(coalesce(r.snapshot -> 'lines', '[]'::jsonb)) order by (value ->> 'line_no')::int loop
      v_no := v_no + 1;
      v_lines := v_lines || jsonb_build_array(l || jsonb_build_object(
        'line_no', v_no, 'order_number', r.o ->> 'order_number',
        'description', format('Order %s · %s', r.o ->> 'order_number', l ->> 'description')));
    end loop;
  end loop;

  select cu.* into c from public.customers cu join public.orders od on od.customer_id = cu.id
   where od.id = v_first.order_id and od.company_id = v_company;
  select jsonb_build_object('name', coalesce(nullif(e.legal_name, ''), e.name), 'address_line1', e.address_line1, 'address_line2', e.address_line2,
                            'city', e.city, 'region', e.region, 'postal_code', e.postal_code, 'phone', e.phone, 'email', e.email)
    into v_entity from public.billing_entities e where e.company_id = v_company and e.is_default and e.active;

  insert into public.invoices (company_id, handoff_order_id, order_id, customer_id, order_number, customer_po, project_name,
                               service_start, service_end, bill_to, issued_by_entity, lines, subtotal_cents, discount_cents,
                               tax_cents, total_cents, terms_days, footer)
  select v_company, v_first.id, v_first.order_id, c.id, array_to_string(v_numbers, ', '),
         coalesce((select string_agg(distinct nullif(h.snapshot -> 'order' ->> 'customer_po', ''), ', ') from public.billing_handoff_orders h where h.id = any (v_ids)), ''),
         case when (select count(distinct coalesce(h.snapshot -> 'order' ->> 'project_name', '')) from public.billing_handoff_orders h where h.id = any (v_ids)) = 1
              then coalesce(v_first.snapshot -> 'order' ->> 'project_name', '') else '' end,
         (select min((h.snapshot -> 'order' ->> 'service_start')::date) from public.billing_handoff_orders h where h.id = any (v_ids)),
         (select max((h.snapshot -> 'order' ->> 'service_end')::date) from public.billing_handoff_orders h where h.id = any (v_ids)),
         jsonb_build_object('name', c.name, 'customer_number', c.customer_number, 'email', c.email, 'line1', c.billing_line1,
                            'line2', c.billing_line2, 'city', c.billing_city, 'state', c.billing_state, 'postal_code', c.billing_postal_code),
         v_entity, v_lines,
         sum(coalesce((h.snapshot -> 'order' ->> 'subtotal_cents')::bigint, 0)), sum(coalesce((h.snapshot -> 'order' ->> 'discount_cents')::bigint, 0)),
         sum(coalesce((h.snapshot -> 'order' ->> 'tax_cents')::bigint, 0)), sum(coalesce((h.snapshot -> 'order' ->> 'total_cents')::bigint, 0)),
         coalesce(v_settings.terms_days, 30), coalesce(v_settings.footer, '')
    from public.billing_handoff_orders h where h.id = any (v_ids)
  returning id into v_id;

  -- The trigger listed the first order; list the others and each order's own total.
  v_pos := 0;
  for r in select h.id, h.order_id, (h.snapshot -> 'order') as o
             from public.billing_handoff_orders h
            where h.id = any (v_ids)
            order by (h.snapshot -> 'order' ->> 'service_start') nulls last, (h.snapshot -> 'order' ->> 'order_number') loop
    v_pos := v_pos + 1;
    if v_pos = 1 then
      update public.invoice_orders set total_cents = coalesce((r.o ->> 'total_cents')::bigint, 0), order_number = r.o ->> 'order_number'
       where invoice_id = v_id and handoff_order_id = r.id;
    else
      insert into public.invoice_orders (company_id, invoice_id, handoff_order_id, order_id, order_number, position, total_cents)
      values (v_company, v_id, r.id, r.order_id, r.o ->> 'order_number', v_pos, coalesce((r.o ->> 'total_cents')::bigint, 0));
    end if;
  end loop;

  perform private.log_event('invoice.created', 'invoice', v_id,
    format('Draft invoice for %s orders: %s', cardinality(v_numbers), array_to_string(v_numbers, ', ')),
    jsonb_build_object('orders', to_jsonb(v_numbers)));
  return v_id;
end;
$$;

-- Demo: one draft invoice that combines two orders of one customer (fictional data; a draft, nothing is sent).
-- Idempotent: skipped when the demo already has a combined invoice or no customer has two orders to combine.
create or replace function public.demo_combined_invoice_sample()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_demo uuid := private.demo_owner_company();
  v_customer uuid;
  v_ready uuid[];
  v_ids uuid[];
begin
  if v_demo is null then
    raise exception 'Demo samples are only added to a demo company, by its owner.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.invoicing_settings s where s.company_id = v_demo and s.issuer = 'taviron') then
    return 0;
  end if;
  if exists (select 1 from public.invoice_orders o join public.invoices i on i.id = o.invoice_id
              where o.company_id = v_demo and i.status <> 'void' and o.position > 1) then
    return 0;
  end if;
  -- A customer with two handed-off orders not invoiced yet; otherwise hand off two ready orders of one customer,
  -- as the office would, leaving at least one order ready to bill.
  select x.customer_id into v_customer from public.invoice_combine_candidates() x
   group by x.customer_id having count(*) >= 2 order by count(*) desc limit 1;
  if v_customer is null then
    select o.customer_id, (array_agg(s.order_id order by s.order_number))[1:2] into v_customer, v_ready
      from public.billing_order_status s join public.orders o on o.id = s.order_id and o.company_id = s.company_id
     where s.company_id = v_demo and s.readiness = 'ready'
     group by o.customer_id having count(*) >= 2
     order by count(*) desc limit 1;
    if v_customer is null or (select count(*) from public.billing_order_status rs where rs.company_id = v_demo and rs.readiness = 'ready') < 3 then
      return 0;
    end if;
    perform public.hand_off_orders(v_ready, 'Demo combined invoice', 'Handed off so the demo shows one invoice for two orders.', gen_random_uuid());
  end if;
  select (array_agg(x.handoff_order_id order by x.service_start, x.order_number))[1:2] into v_ids
    from public.invoice_combine_candidates() x where x.customer_id = v_customer;
  if coalesce(cardinality(v_ids), 0) < 2 then
    return 0;
  end if;
  perform public.invoice_create_combined(v_ids);
  return 1;
end;
$$;

revoke all on function public.invoice_combine_candidates(), public.invoice_create_combined(uuid[]), public.demo_combined_invoice_sample() from public, anon;
grant execute on function public.invoice_combine_candidates(), public.invoice_create_combined(uuid[]), public.demo_combined_invoice_sample() to authenticated;

-- Revenue check (20261120005100): a voided invoice is "not replaced" while any of its orders is on no active invoice.
create or replace function public.revenue_leaks(p_days integer default 7, p_include_checked boolean default false)
returns table (finding_key text, kind text, order_id uuid, order_number text, customer_name text, ref_id uuid, ref_label text,
               detail text, amount_cents bigint, estimated boolean, since date, checked_reason text, checked_at timestamptz)
language plpgsql
stable
security invoker
set search_path = ''
as $$
-- Runs with the caller's own rights (RLS): company, billing.view and dispatch-base access apply to every row read.
declare
  v_company uuid := private.current_company_id();
  v_today date;
begin
  if v_company is null or not private.has_permission('billing.view') then
    raise exception 'You do not have permission to perform this action (billing.view).' using errcode = '42501';
  end if;
  if p_days is null or p_days not between 1 and 90 then
    raise exception 'Choose 1 to 90 days.' using errcode = '22023';
  end if;
  v_today := (now() at time zone coalesce((select cs.timezone from public.company_settings cs where cs.company_id = v_company), 'America/Chicago'))::date;

  return query
  with
  delivered as (
    -- Value of accepted deliveries per order at the order's own rates (per-unit lines with matching units only).
    select b.order_id, sum(round(b.delivered_quantity * b.unit_rate_cents))::bigint as value_cents
    from public.billing_line_status b
    where b.company_id = v_company and b.delivered_quantity is not null and b.other_unit_count = 0
    group by b.order_id
  ),
  found as (
    select 'not_billed:' || s.order_id as k, 'not_billed'::text as kd, s.order_id as oid, s.order_number as onum, s.customer_name as cust,
           s.order_id as rid, s.order_number as rlabel,
           format('Ready to bill since the last delivery on %s; not handed off.', to_char(s.service_end, 'Mon DD')) as det,
           coalesce(d.value_cents, s.total_cents::bigint) as amt, d.value_cents is not null as est, s.service_end as sn
    from public.billing_order_status s
    left join delivered d on d.order_id = s.order_id
    where s.company_id = v_company and s.readiness = 'ready' and s.service_end <= v_today - p_days
    union all
    select 'stuck:' || s.order_id || ':' || s.readiness, 'stuck', s.order_id, s.order_number, s.customer_name, s.order_id, s.order_number,
           case s.readiness
             when 'missing_documentation' then format('%s delivered without a ticket; billing waits on paperwork.', case s.loads_missing when 1 then '1 load' else s.loads_missing || ' loads' end)
             when 'needs_review' then case s.tickets_pending when 1 then '1 ticket waiting for review; billing waits on it.' else s.tickets_pending || ' tickets waiting for review; billing waits on them.' end
             else case s.exceptions_count when 1 then '1 billing exception to resolve or acknowledge.' else s.exceptions_count || ' billing exceptions to resolve or acknowledge.' end end,
           coalesce(d.value_cents, s.total_cents::bigint), d.value_cents is not null, s.service_end
    from public.billing_order_status s
    left join delivered d on d.order_id = s.order_id
    where s.company_id = v_company and s.readiness in ('missing_documentation', 'needs_review', 'blocked')
      and s.service_end <= v_today - p_days and s.tickets_accepted > 0
    union all
    -- Handed off for a different quantity than delivered (frozen at handoff; per-unit lines in the same unit).
    select case when (l ->> 'delivered_quantity')::numeric > (l ->> 'quantity')::numeric then 'billed_short:' else 'billed_over:' end
             || h.id || ':' || (l ->> 'line_id') || ':' || (l ->> 'quantity') || ':' || (l ->> 'delivered_quantity'),
           case when (l ->> 'delivered_quantity')::numeric > (l ->> 'quantity')::numeric then 'billed_short' else 'billed_over' end,
           h.order_id, h.snapshot -> 'order' ->> 'order_number', h.snapshot -> 'order' ->> 'customer_name', h.id, h.snapshot -> 'order' ->> 'order_number',
           format('%s: billed %s %s, tickets show %s.', l ->> 'description', trim_scale((l ->> 'quantity')::numeric)::text,
                  l ->> 'unit_code', trim_scale((l ->> 'delivered_quantity')::numeric)::text),
           round(((l ->> 'delivered_quantity')::numeric - (l ->> 'quantity')::numeric) * (l ->> 'unit_rate_cents')::numeric)::bigint,
           true, (h.snapshot -> 'order' ->> 'service_end')::date
    from public.billing_handoff_orders h
    cross join lateral jsonb_array_elements(h.snapshot -> 'lines') l
    where h.company_id = v_company and h.reverted_at is null
      and l ->> 'calc_method' = 'per_unit' and l ->> 'delivered_quantity' is not null and l ->> 'unit_rate_cents' is not null
      and (l ->> 'delivered_quantity')::numeric <> (l ->> 'quantity')::numeric
    union all
    select 'zero_rate:' || b.line_id || ':' || b.delivered_quantity, 'zero_rate', b.order_id, b.order_number, c.name, b.line_id, b.order_number,
           format('%s: %s %s delivered at $0.', b.description, trim_scale(b.delivered_quantity)::text, b.unit_code),
           null::bigint, false, o.order_date
    from public.billing_line_status b
    join public.orders o on o.id = b.order_id and o.company_id = b.company_id
    join public.customers c on c.id = o.customer_id
    where b.company_id = v_company and b.pricing_check = 'zero_rate' and b.kind <> 'discount' and coalesce(b.delivered_quantity, 0) > 0
    union all
    select 'below_price_list:' || ol.id || ':' || ol.unit_rate_cents || ':' || coalesce(b.delivered_quantity, ol.quantity), 'below_price_list',
           o.id, o.order_number, c.name, ol.id, o.order_number,
           format('%s: $%s per %s, price list $%s.', ol.description, to_char(ol.unit_rate_cents / 100.0, 'FM999,990.00'), ol.unit_code,
                  to_char(ol.catalog_rate_cents / 100.0, 'FM999,990.00')),
           round((ol.catalog_rate_cents - ol.unit_rate_cents) * coalesce(b.delivered_quantity, ol.quantity))::bigint, true, o.order_date
    from public.order_lines ol
    join public.orders o on o.id = ol.order_id and o.company_id = ol.company_id
    join public.customers c on c.id = o.customer_id
    left join public.billing_line_status b on b.line_id = ol.id and b.company_id = ol.company_id and b.other_unit_count = 0
    where ol.company_id = v_company and ol.calc_method = 'per_unit' and ol.unit_rate_cents > 0
      and ol.catalog_rate_cents is not null and ol.unit_rate_cents < ol.catalog_rate_cents
      and o.status not in ('draft', 'canceled')
    union all
    select 'voided_invoice:' || i.id, 'voided_invoice', i.order_id, i.order_number, c.name, i.id, coalesce(i.number, 'Draft'),
           format('Invoice %s was voided (%s) and not replaced.', coalesce(i.number, 'draft'), i.void_reason),
           i.total_cents::bigint, false, i.voided_at::date
    from public.invoices i
    join public.customers c on c.id = i.customer_id
    where i.company_id = v_company and i.status = 'void' and i.number is not null
      and exists (select 1 from public.invoice_orders v
                    join public.billing_handoff_orders h on h.id = v.handoff_order_id and h.reverted_at is null
                   where v.invoice_id = i.id
                   and not exists (select 1 from public.invoice_orders a where a.handoff_order_id = v.handoff_order_id and a.active))
  )
  select f.k, f.kd, f.oid, f.onum, f.cust, f.rid, f.rlabel, f.det, f.amt, f.est, f.sn, r.reason, r.reviewed_at
  from found f
  left join public.revenue_leak_reviews r on r.company_id = v_company and r.finding_key = f.k
  where p_include_checked or r.id is null
  order by f.amt desc nulls first, f.sn;
end;
$$;
