-- =============================================================================
-- Revenue leakage finder (B110, owner 2026-11-01). Finds money the records say is owed but is not (yet) billed, from
-- the company's own orders, tickets, billing handoffs and invoices. Findings only: nothing is billed, changed or sent.
--
-- Kinds (amounts from the records; "estimated" marks a figure computed from rates rather than an issued amount):
--   not_billed        delivered and ready to bill, last delivery more than N days ago, not handed off
--   stuck             delivered more than N days ago, billing held by missing tickets, review or exceptions
--   billed_short      handed off for fewer units than the accepted tickets delivered (snapshot at handoff)
--   billed_over       handed off for more units than delivered (a likely dispute; shown as negative)
--   zero_rate         delivered on a line priced at $0
--   below_price_list  a line priced below its price-list rate when the order was made
--   voided_invoice    a Taviron invoice voided and not replaced, while the order is still handed off
-- A person may mark a finding "checked" with a reason; it stays hidden until its amount changes.
-- Reads: billing.view, with the caller's own row access (security invoker). Marking: billing.manage. Reversible: supabase/rollbacks/20261120005100_revenue_leaks.down.sql
-- =============================================================================

create table public.revenue_leak_reviews (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null default private.current_company_id() references public.companies (id),
  finding_key  text not null check (length(finding_key) between 10 and 200),
  kind         text not null,
  reason       text not null check (length(reason) between 3 and 300),
  reviewed_by  uuid default auth.uid() references auth.users (id) on delete set null,
  reviewed_at  timestamptz not null default now(),
  unique (company_id, finding_key)
);
alter table public.revenue_leak_reviews enable row level security;
revoke all on public.revenue_leak_reviews from anon, authenticated;
grant select on public.revenue_leak_reviews to authenticated;
create policy revenue_leak_reviews_read on public.revenue_leak_reviews for select to authenticated
  using (company_id = (select private.current_company_id()) and (select private.has_permission('billing.view')));

-- Every open finding of the caller's company. p_days: how old a delivery must be to count as not billed (1–90).
-- p_include_checked: also return findings a person marked checked (with their review).
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

-- Mark a finding checked (it stays hidden until its amount or quantities change, which changes its key).
create or replace function public.revenue_leak_check(p_key text, p_kind text, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v_reason text := btrim(coalesce(p_reason, ''));
begin
  perform private.require_permission('billing.manage');
  if p_key is null or length(p_key) not between 10 and 200 or split_part(p_key, ':', 1) <> p_kind
     or p_kind not in ('not_billed', 'stuck', 'billed_short', 'billed_over', 'zero_rate', 'below_price_list', 'voided_invoice') then
    raise exception 'Unknown finding.' using errcode = '22023';
  end if;
  if length(v_reason) < 3 or length(v_reason) > 300 then
    raise exception 'Say why this is fine (3 to 300 characters).' using errcode = '22023';
  end if;
  insert into public.revenue_leak_reviews (company_id, finding_key, kind, reason) values (v_company, p_key, p_kind, v_reason)
  on conflict (company_id, finding_key) do update set reason = excluded.reason, reviewed_by = auth.uid(), reviewed_at = now();
  perform private.log_event('revenue_leak.checked', 'company', v_company, format('Revenue finding checked: %s', v_reason),
                            jsonb_build_object('finding', p_key, 'kind', p_kind));
end;
$$;

-- Show a checked finding again (the review is kept in the audit log).
create or replace function public.revenue_leak_reopen(p_key text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v_reason text;
begin
  perform private.require_permission('billing.manage');
  update public.revenue_leak_reviews set reason = '[reopened] ' || left(reason, 280), finding_key = 'reopened:' || id || ':' || left(finding_key, 150)
   where company_id = v_company and finding_key = p_key
  returning reason into v_reason;
  if v_reason is null then
    raise exception 'Finding not found.' using errcode = 'P0002';
  end if;
  perform private.log_event('revenue_leak.reopened', 'company', v_company, 'Revenue finding shown again', jsonb_build_object('finding', p_key));
end;
$$;

revoke all on function public.revenue_leaks(integer, boolean), public.revenue_leak_check(text, text, text), public.revenue_leak_reopen(text) from public, anon;
grant execute on function public.revenue_leaks(integer, boolean), public.revenue_leak_check(text, text, text), public.revenue_leak_reopen(text) to authenticated;
