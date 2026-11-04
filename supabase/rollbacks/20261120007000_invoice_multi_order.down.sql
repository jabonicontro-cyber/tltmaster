-- Rollback for 20261120007000_invoice_multi_order.sql. Refused while a combined invoice (more than one order) exists
-- that is not void: removing the link table would leave that invoice's other orders free to be billed twice.
begin;
do $$
begin
  if exists (select 1 from public.invoice_orders o join public.invoices i on i.id = o.invoice_id where o.position > 1 and i.status <> 'void') then
    raise exception 'Combined invoices exist. Void them before rolling back.';
  end if;
end;
$$;
drop function if exists public.demo_combined_invoice_sample();
drop function if exists public.invoice_create_combined(uuid[]);
drop function if exists public.invoice_combine_candidates();
drop trigger if exists invoice_orders_on_void on public.invoices;
drop trigger if exists invoice_orders_on_insert on public.invoices;
drop function if exists private.invoice_orders_on_void();
drop function if exists private.invoice_orders_on_insert();
drop table if exists public.invoice_orders;
-- The dates check as it was (not validated: drafts discarded meanwhile keep no dates).
alter table public.invoices drop constraint if exists invoices_dates_when_numbered;
alter table public.invoices drop constraint if exists invoices_check2;
alter table public.invoices add constraint invoices_check2 check (status = 'draft' or (issue_date is not null and due_date is not null)) not valid;
-- The revenue check as it was in 20261120005100.
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
    join public.billing_handoff_orders h on h.id = i.handoff_order_id and h.reverted_at is null
    where i.company_id = v_company and i.status = 'void' and i.number is not null
      and not exists (select 1 from public.invoices j where j.handoff_order_id = i.handoff_order_id and j.status <> 'void')
  )
  select f.k, f.kd, f.oid, f.onum, f.cust, f.rid, f.rlabel, f.det, f.amt, f.est, f.sn, r.reason, r.reviewed_at
  from found f
  left join public.revenue_leak_reviews r on r.company_id = v_company and r.finding_key = f.k
  where p_include_checked or r.id is null
  order by f.amt desc nulls first, f.sn;
end;
$$;
commit;
