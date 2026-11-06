-- Detention charges from recorded waits (DT1, owner 2026-11-05) and charges billed without a ticket (MK2).
--
-- * charge_items.ticket_required (default true, so nothing changes): a charge billed per occurrence (detention, lumper,
--   truck ordered not used) is set to false and its order lines no longer wait for a delivery ticket in billing.
-- * customers.detention_free_minutes / detention_rate_cents: off until both are set for a customer (owner: no default).
-- * detention_proposals(order): stops of the order's loads where the recorded wait (Arrived to Left) passed the
--   customer's free time; detention_apply adds the charge as an order line (a person decides; nothing is automatic),
--   detention_dismiss records "not billed" with a reason. Each stop is decided once.
-- Rollback: supabase/rollbacks/20261120008200_detention.down.sql

alter table public.charge_items add column if not exists ticket_required boolean not null default true;

alter table public.customers
  add column if not exists detention_free_minutes integer check (detention_free_minutes between 0 and 1440),
  add column if not exists detention_rate_cents integer check (detention_rate_cents between 1 and 100000000);
alter table public.customers drop constraint if exists customers_detention_pair;
alter table public.customers add constraint customers_detention_pair
  check ((detention_free_minutes is null) = (detention_rate_cents is null));

alter table public.load_stop_times
  add column if not exists detention_status text check (detention_status in ('applied', 'dismissed')),
  add column if not exists detention_order_line_id uuid,
  add column if not exists detention_reason text not null default '' check (length(detention_reason) <= 300),
  add column if not exists detention_decided_by uuid references auth.users (id) on delete set null,
  add column if not exists detention_decided_at timestamptz;

-- Billing: lines of charges billed without a ticket are not waiting for one (same columns as before).
create or replace view public.billing_line_status with (security_invoker = true) as
SELECT ol.id AS line_id,
    ol.company_id,
    ol.order_id,
    o.order_number,
    o.status AS order_status,
    ol.line_no,
    ol.kind,
    ol.description,
    ol.material_id,
    ol.unit_code,
    ol.quantity AS ordered_quantity,
    ol.unit_rate_cents,
    ol.amount_cents,
    ol.price_source,
    COALESCE(t.live_count, 0::bigint)::integer AS live_count,
    COALESCE(t.pending_count, 0::bigint)::integer AS pending_count,
    COALESCE(t.other_unit_count, 0::bigint)::integer AS other_unit_count,
    t.delivered_quantity,
    t.ticket_units,
        CASE
            WHEN o.status <> 'completed'::order_status AND NOT COALESCE(f.fulfilled, false) THEN 'in_progress'::text
            WHEN COALESCE(t.live_count, 0::bigint) = 0 THEN 'no_tickets'::text
            WHEN t.other_unit_count > 0 THEN 'units_differ'::text
            WHEN t.delivered_quantity = ol.quantity THEN 'match'::text
            WHEN t.delivered_quantity > ol.quantity THEN 'over'::text
            ELSE 'under'::text
        END AS quantity_check,
        CASE
            WHEN COALESCE(t.live_count, 0::bigint) > 0 AND t.other_unit_count = 0 THEN t.delivered_quantity - ol.quantity
            ELSE NULL::numeric
        END AS quantity_difference,
        CASE
            WHEN ol.unit_rate_cents = 0 THEN 'zero_rate'::text
            ELSE 'ok'::text
        END AS pricing_check
   FROM order_lines ol
     JOIN orders o ON o.id = ol.order_id AND o.company_id = ol.company_id
     LEFT JOIN order_fulfillment f ON f.order_id = o.id
     LEFT JOIN LATERAL ( SELECT count(*) AS live_count,
            count(*) FILTER (WHERE dt.status = ANY (ARRAY['submitted'::ticket_status, 'needs_review'::ticket_status])) AS pending_count,
            count(*) FILTER (WHERE dt.unit_code IS DISTINCT FROM ol.unit_code) AS other_unit_count,
            sum(dt.quantity) FILTER (WHERE dt.unit_code = ol.unit_code) AS delivered_quantity,
            array_agg(DISTINCT dt.unit_code) AS ticket_units
           FROM delivery_tickets dt
          WHERE dt.order_line_id = ol.id AND dt.company_id = ol.company_id AND (dt.status = ANY (ARRAY['submitted'::ticket_status, 'needs_review'::ticket_status, 'accepted'::ticket_status]))) t ON true
  WHERE ol.calc_method = 'per_unit'::calc_method AND ol.kind <> 'discount'::charge_kind
    AND NOT EXISTS (SELECT 1 FROM charge_items ci WHERE ci.id = ol.charge_item_id AND ci.company_id = ol.company_id AND NOT ci.ticket_required) AND (o.status = ANY (ARRAY['scheduled'::order_status, 'dispatched'::order_status, 'in_progress'::order_status, 'partially_completed'::order_status, 'completed'::order_status]));


-- The order guards (20261012000100) keep confirmed orders' lines and totals fixed. One narrow exception, set only inside
-- detention_apply for its own transaction (tlt.billed_extra): billing may INSERT an extra charge line (never change or
-- delete one) and the order's subtotal, taxable amount, tax and total may follow it. Customer, tax rate and terms
-- still never change.
create or replace function private.guard_order_lines()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_order_id uuid := coalesce(new.order_id, old.order_id);
begin
  if current_setting('tlt.order_conversion', true) = 'on'
     or (tg_op = 'DELETE' and current_setting('tlt.sample_purge', true) = 'on')
     or (tg_op = 'INSERT' and current_setting('tlt.billed_extra', true) = 'on') then
    return coalesce(new, old);
  end if;
  if not exists (
    select 1 from public.orders o
    where o.id = v_order_id and o.status = 'draft' and o.source_quote_id is null
  ) then
    raise exception 'Lines of a confirmed or quote-linked order cannot be changed.' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and new.order_id <> old.order_id then
    raise exception 'Order lines cannot be moved between orders.' using errcode = '42501';
  end if;
  return coalesce(new, old);
end;
$$;

create or replace function private.guard_order_pricing()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.order_number is distinct from old.order_number
     or new.source_quote_id is distinct from old.source_quote_id
     or new.source_quote_version_id is distinct from old.source_quote_version_id then
    raise exception 'Order number and source quote cannot change.' using errcode = '42501';
  end if;
  if (old.status <> 'draft' or old.source_quote_id is not null)
     and (new.customer_id, new.tax_rate_bp, new.terms) is distinct from (old.customer_id, old.tax_rate_bp, old.terms) then
    raise exception 'Prices, totals, terms and customer of a confirmed or quote-linked order cannot be changed.'
      using errcode = '42501';
  end if;
  if (old.status <> 'draft' or old.source_quote_id is not null)
     and current_setting('tlt.billed_extra', true) is distinct from 'on'
     and (new.subtotal_cents, new.discount_cents, new.taxable_cents, new.tax_cents, new.total_cents)
         is distinct from (old.subtotal_cents, old.discount_cents, old.taxable_cents, old.tax_cents, old.total_cents) then
    raise exception 'Prices, totals, terms and customer of a confirmed or quote-linked order cannot be changed.'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

-- One place computes a stop's detention: wait = Left minus Arrived in whole minutes; billable = wait minus the
-- customer's free minutes; hours = billable / 60 rounded to 0.01; amount = hours x hourly rate, rounded to the cent.
create or replace function private.detention_rows(p_company uuid, p_order uuid)
returns table (
  stop_time_id uuid, load_id uuid, load_number integer, load_date date, stop text, place text,
  arrived_at timestamptz, departed_at timestamptz, wait_minutes integer, free_minutes integer, billable_minutes integer,
  hours numeric, rate_cents integer, amount_cents bigint, status text, reason text, order_line_id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  select st.id, st.load_id, l.load_number, l.load_date, st.stop,
         coalesce(case
           when st.stop = 'site' then nullif(o.site_label, '')
           when st.stop = 'pickup' then (select cl.name from public.company_locations cl where cl.id = st.location_id)
           when st.stop like 'stop:%' then (select os.name from public.order_stops os where os.id = st.order_stop_id)
         end, case when st.stop = 'pickup' then 'Pickup' else 'Delivery' end),
         st.arrived_at, st.departed_at, w.wait, c.detention_free_minutes, greatest(w.wait - c.detention_free_minutes, 0),
         round(greatest(w.wait - c.detention_free_minutes, 0) / 60.0, 2), c.detention_rate_cents,
         round(round(greatest(w.wait - c.detention_free_minutes, 0) / 60.0, 2) * c.detention_rate_cents)::bigint,
         st.detention_status, st.detention_reason, st.detention_order_line_id
  from public.load_stop_times st
  join public.orders o on o.id = st.order_id and o.company_id = st.company_id
  join public.order_loads l on l.id = st.load_id and l.company_id = st.company_id
  join public.customers c on c.id = o.customer_id and c.company_id = o.company_id
  cross join lateral (select floor(extract(epoch from (st.departed_at - st.arrived_at)) / 60)::integer as wait) w
  where st.company_id = p_company and st.order_id = p_order
    and st.arrived_at is not null and st.departed_at is not null
    and c.detention_free_minutes is not null and c.detention_rate_cents is not null
    and w.wait > c.detention_free_minutes
$$;

create or replace function public.detention_proposals(p_order uuid)
returns table (
  stop_time_id uuid, load_id uuid, load_number integer, load_date date, stop text, place text,
  arrived_at timestamptz, departed_at timestamptz, wait_minutes integer, free_minutes integer, billable_minutes integer,
  hours numeric, rate_cents integer, amount_cents bigint, status text, reason text, order_line_id uuid)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_permission('billing.view');
  return query select * from private.detention_rows(private.require_company(), p_order) order by 4, 3, 5;
end;
$$;

create or replace function public.detention_apply(p_stop_time uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid;
  v_st      public.load_stop_times%rowtype;
  v_row     record;
  v_order   public.orders%rowtype;
  v_item    uuid;
  v_line    uuid;
  v_no      integer;
begin
  perform private.require_permission('billing.manage');
  v_company := private.require_company();
  select * into v_st from public.load_stop_times where id = p_stop_time and company_id = v_company for update;
  if not found then raise exception 'Stop not found.'; end if;
  if v_st.detention_status is not null then
    raise exception 'Detention for this stop was already decided.' using errcode = 'PT409';
  end if;
  select * into v_order from public.orders where id = v_st.order_id and company_id = v_company for update;
  if v_order.status in ('draft', 'canceled') then raise exception 'Detention is added to scheduled or completed orders only.'; end if;
  if exists (select 1 from public.billing_order_status s where s.order_id = v_order.id and s.company_id = v_company and s.readiness = 'handed_off') then
    raise exception 'This order was already handed off for billing. Undo the handoff first.';
  end if;
  select * into v_row from private.detention_rows(v_company, v_order.id) r where r.stop_time_id = p_stop_time;
  if not found or v_row.billable_minutes <= 0 then
    raise exception 'No detention to add: the wait is within the customer''s free time, a time is missing, or the customer has no detention rate.';
  end if;
  if not exists (select 1 from public.units_of_measure where company_id = v_company and code = 'hour') then
    raise exception 'Add the unit "hour" (Rates and pricing, Units) before adding detention.';
  end if;

  -- The company's detention charge: its own (code DETENTION, or an hourly charge named Detention...), else one is
  -- created, billed without a ticket.
  select id into v_item from public.charge_items
  where company_id = v_company and active and (upper(code) = 'DETENTION' or (default_unit_code = 'hour' and lower(name) like 'detention%'))
  order by (upper(coalesce(code, '')) = 'DETENTION') desc, created_at limit 1;
  if v_item is null then
    insert into public.charge_items (company_id, code, name, description, kind, calc_method, default_unit_code, ticket_required)
    values (v_company, 'DETENTION', 'Detention (per hour)', 'Waiting time past the customer''s free time, from recorded Arrived and Left times.',
            'service', 'per_unit', 'hour', false)
    on conflict do nothing
    returning id into v_item;
    if v_item is null then
      select id into v_item from public.charge_items where company_id = v_company and upper(code) = 'DETENTION' limit 1;
    end if;
  end if;

  perform set_config('tlt.billed_extra', 'on', true);
  select coalesce(max(line_no), 0) + 1 into v_no from public.order_lines where order_id = v_order.id;
  insert into public.order_lines (company_id, order_id, line_no, kind, calc_method, charge_item_id, description, unit_code,
                                  unit_label, quantity, unit_rate_cents, price_source, taxable, amount_cents)
  values (v_company, v_order.id, v_no, 'service', 'per_unit', v_item,
          left(format('Detention: %s, %s, waited %s h %s min (%s min free)', v_row.place, to_char(v_row.load_date, 'Mon FMDD'),
                      v_row.wait_minutes / 60, lpad((v_row.wait_minutes % 60)::text, 2, '0'), v_row.free_minutes), 300),
          'hour', 'hours', v_row.hours, v_row.rate_cents, 'manual', false, v_row.amount_cents)
  returning id into v_line;
  perform private.recompute_order_totals(v_order.id);
  update public.orders set edit_seq = edit_seq + 1 where id = v_order.id;
  perform set_config('tlt.billed_extra', 'off', true);

  update public.load_stop_times
  set detention_status = 'applied', detention_order_line_id = v_line, detention_decided_by = auth.uid(), detention_decided_at = now()
  where id = p_stop_time;
  perform private.log_event('billing.detention_added', 'order', v_order.id,
    format('Detention added: %s, %s h at %s per hour', v_row.place, v_row.hours, to_char(v_row.rate_cents / 100.0, 'FM999999990.00')),
    jsonb_build_object('stop_time_id', p_stop_time, 'order_line_id', v_line, 'billable_minutes', v_row.billable_minutes, 'amount_cents', v_row.amount_cents));
  return v_line;
end;
$$;

create or replace function public.detention_dismiss(p_stop_time uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid;
  v_reason  text := btrim(coalesce(p_reason, ''));
  v_st      public.load_stop_times%rowtype;
begin
  perform private.require_permission('billing.manage');
  v_company := private.require_company();
  if v_reason = '' then raise exception 'Say why this detention is not billed.'; end if;
  if length(v_reason) > 300 then raise exception 'Keep the reason under 300 characters.'; end if;
  select * into v_st from public.load_stop_times where id = p_stop_time and company_id = v_company for update;
  if not found then raise exception 'Stop not found.'; end if;
  if v_st.detention_status is not null then
    raise exception 'Detention for this stop was already decided.' using errcode = 'PT409';
  end if;
  update public.load_stop_times
  set detention_status = 'dismissed', detention_reason = v_reason, detention_decided_by = auth.uid(), detention_decided_at = now()
  where id = p_stop_time;
  perform private.log_event('billing.detention_dismissed', 'order', v_st.order_id, format('Detention not billed: %s', v_reason),
    jsonb_build_object('stop_time_id', p_stop_time));
end;
$$;

revoke all on function private.detention_rows(uuid, uuid), public.detention_proposals(uuid), public.detention_apply(uuid),
  public.detention_dismiss(uuid, text) from public, anon;
grant execute on function public.detention_proposals(uuid), public.detention_apply(uuid), public.detention_dismiss(uuid, text) to authenticated;
