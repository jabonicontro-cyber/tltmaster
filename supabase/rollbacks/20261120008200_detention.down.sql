-- Rollback of 20261120008200_detention (run by hand only with the owner's approval). Detention lines already added to
-- orders stay as ordinary order lines (their charge then waits for a ticket again in billing, as before).
-- The order guards as in 20261012000100.
create or replace function private.guard_order_lines()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_order_id uuid := coalesce(new.order_id, old.order_id);
begin
  if current_setting('tlt.order_conversion', true) = 'on'
     or (tg_op = 'DELETE' and current_setting('tlt.sample_purge', true) = 'on') then
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
     and (new.customer_id, new.tax_rate_bp, new.subtotal_cents, new.discount_cents, new.taxable_cents,
          new.tax_cents, new.total_cents, new.terms)
         is distinct from
         (old.customer_id, old.tax_rate_bp, old.subtotal_cents, old.discount_cents, old.taxable_cents,
          old.tax_cents, old.total_cents, old.terms) then
    raise exception 'Prices, totals, terms and customer of a confirmed or quote-linked order cannot be changed.'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop function if exists public.detention_dismiss(uuid, text);
drop function if exists public.detention_apply(uuid);
drop function if exists public.detention_proposals(uuid);
drop function if exists private.detention_rows(uuid, uuid);

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
  WHERE ol.calc_method = 'per_unit'::calc_method AND ol.kind <> 'discount'::charge_kind AND (o.status = ANY (ARRAY['scheduled'::order_status, 'dispatched'::order_status, 'in_progress'::order_status, 'partially_completed'::order_status, 'completed'::order_status]));

alter table public.load_stop_times
  drop column if exists detention_decided_at, drop column if exists detention_decided_by, drop column if exists detention_reason,
  drop column if exists detention_order_line_id, drop column if exists detention_status;
alter table public.customers drop constraint if exists customers_detention_pair;
alter table public.customers drop column if exists detention_rate_cents, drop column if exists detention_free_minutes;
alter table public.charge_items drop column if exists ticket_required;
