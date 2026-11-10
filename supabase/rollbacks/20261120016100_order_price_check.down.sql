-- Rollback of 20261120016100_order_price_check (financial review M1). Run with psql -v ON_ERROR_STOP=1 -1 -f.
--   * private.require_order_draft_save: the 20261120009900 definition (no tax checks).
--   * save_order_draft, hand_off_orders, invoice_create, invoice_create_combined: the added line is taken out again.
--   * billing_line_status (20261120008200) and billing_order_status (20261120001900, without price_check_pending; the
--     view is dropped and created again because a column cannot be removed in place; nothing depends on it).
--   * The new functions and columns go: who typed a price and who confirmed it are lost (they are also in the audit
--     log, which stays). Orders waiting for a price check become billable as before.
begin;

create or replace function private.require_order_draft_save(p_payload jsonb)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company  uuid;
  v_order_id uuid := nullif(p_payload ->> 'order_id', '')::uuid;
  v_customer uuid := nullif(p_payload ->> 'customer_id', '')::uuid;
  v_order    public.orders%rowtype;
  v_name     text;
begin
  if private.has_permission('orders.edit') then
    return;
  end if;
  perform private.require_permission('orders.create');
  v_company := private.require_company();

  if v_order_id is not null then
    select * into v_order from public.orders where id = v_order_id and company_id = v_company;
    -- Not found: save_order_draft answers "Order not found."
    if found and (v_order.created_by is distinct from auth.uid() or v_order.status <> 'draft' or v_order.source_quote_id is not null) then
      raise exception 'Only the person who started this new order, or someone who can change orders, can change it.'
        using errcode = '42501';
    end if;
  end if;

  if v_customer is not null
     and (v_order_id is null or v_order.customer_id is distinct from v_customer)
     and exists (select 1 from private.credit_holds(v_company, array[v_customer])) then
    select c.name into v_name from public.customers c where c.id = v_customer and c.company_id = v_company;
    raise exception '% is on credit hold. A new order for them needs someone who can change orders: they decide whether to go ahead and record why.',
      coalesce(v_name, 'This customer') using errcode = '42501';
  end if;
end;
$$;
revoke all on function private.require_order_draft_save(jsonb) from public, anon, authenticated;

do $$
declare
  v_def text;
  v_patch record;
begin
  for v_patch in
    select * from (values
      ('public.save_order_draft(jsonb)'::regprocedure,
       '  perform private.order_price_check_after_save(v_order.id);
'),
      ('public.hand_off_orders(uuid[], text, text, uuid)'::regprocedure,
       '
  perform private.require_prices_checked(v_ids);'),
      ('public.invoice_create(uuid)'::regprocedure,
       '  perform private.require_prices_checked(array[h.order_id]);
'),
      ('public.invoice_create_combined(uuid[])'::regprocedure,
       '
  perform private.require_prices_checked(array(select h.order_id from public.billing_handoff_orders h where h.id = any (v_ids) and h.company_id = v_company));')
    ) as t(fn, added)
  loop
    v_def := pg_get_functiondef(v_patch.fn);
    if position(v_patch.added in v_def) = 0 then
      continue; -- not patched (already rolled back)
    end if;
    execute replace(v_def, v_patch.added, '');
  end loop;
end;
$$;

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

drop view public.billing_order_status;
create view public.billing_order_status with (security_invoker = true) as
WITH base AS (
         SELECT o.id AS order_id,
            o.company_id,
            o.order_number,
            o.status,
            o.customer_id,
            c.name AS customer_name,
            c.customer_number,
            o.project_name,
            o.customer_po,
            o.order_date,
            o.scheduled_start,
            o.scheduled_end,
            o.completed_at,
            o.total_cents,
            o.is_sample,
            COALESCE(l.first_load_date, o.scheduled_start) AS service_start,
            COALESCE(l.last_load_date, o.scheduled_end, o.scheduled_start) AS service_end,
            COALESCE(l.loads_total, 0) AS loads_total,
            COALESCE(l.loads_due, 0) AS loads_due,
            COALESCE(l.loads_missing, 0) AS loads_missing,
            COALESCE(l.loads_not_due, 0) AS loads_not_due,
            COALESCE(t.tickets_live, 0) AS tickets_live,
            COALESCE(t.tickets_pending, 0) AS tickets_pending,
            COALESCE(t.tickets_accepted, 0) AS tickets_accepted,
            COALESCE(t.documents_fingerprint, md5(''::text)) AS documents_fingerprint,
            COALESCE(e.exceptions_count, 0) AS exceptions_count,
            COALESCE(e.exceptions_fingerprint, md5(''::text)) AS exceptions_fingerprint
           FROM orders o
             LEFT JOIN customers c ON c.id = o.customer_id AND c.company_id = o.company_id
             LEFT JOIN LATERAL ( SELECT count(*)::integer AS loads_total,
                    count(*) FILTER (WHERE s.is_due)::integer AS loads_due,
                    count(*) FILTER (WHERE s.documentation_state = 'missing'::text)::integer AS loads_missing,
                    count(*) FILTER (WHERE s.documentation_state = 'not_due'::text)::integer AS loads_not_due,
                    min(s.load_date) AS first_load_date,
                    max(s.load_date) AS last_load_date
                   FROM billing_load_status s
                  WHERE s.company_id = o.company_id AND s.order_id = o.id) l ON true
             LEFT JOIN LATERAL ( SELECT count(*) FILTER (WHERE dt.status = ANY (ARRAY['submitted'::ticket_status, 'needs_review'::ticket_status, 'accepted'::ticket_status]))::integer AS tickets_live,
                    count(*) FILTER (WHERE dt.status = ANY (ARRAY['submitted'::ticket_status, 'needs_review'::ticket_status]))::integer AS tickets_pending,
                    count(*) FILTER (WHERE dt.status = 'accepted'::ticket_status)::integer AS tickets_accepted,
                    md5(string_agg((dt.id::text || ':'::text) || dt.status::text, ','::text ORDER BY dt.id)) AS documents_fingerprint
                   FROM delivery_tickets dt
                  WHERE dt.company_id = o.company_id AND dt.order_id = o.id AND dt.status <> 'superseded'::ticket_status) t ON true
             LEFT JOIN LATERAL ( SELECT count(*)::integer AS exceptions_count,
                    md5(string_agg(be.key, ','::text ORDER BY be.key)) AS exceptions_fingerprint
                   FROM billing_exceptions be
                  WHERE be.company_id = o.company_id AND be.order_id = o.id) e ON true
          WHERE o.status = ANY (ARRAY['scheduled'::order_status, 'dispatched'::order_status, 'in_progress'::order_status, 'partially_completed'::order_status, 'completed'::order_status])
        )
 SELECT b.order_id,
    b.company_id,
    b.order_number,
    b.status,
    b.customer_id,
    b.customer_name,
    b.customer_number,
    b.project_name,
    b.customer_po,
    b.order_date,
    b.scheduled_start,
    b.scheduled_end,
    b.completed_at,
    b.total_cents,
    b.is_sample,
    b.service_start,
    b.service_end,
    b.loads_total,
    b.loads_due,
    b.loads_missing,
    b.loads_not_due,
    b.tickets_live,
    b.tickets_pending,
    b.tickets_accepted,
    b.documents_fingerprint,
    b.exceptions_count,
    b.exceptions_fingerprint,
    r.id AS acknowledgment_id,
    r.decided_by AS acknowledged_by,
    r.decided_at AS acknowledged_at,
    r.reason AS acknowledgment_reason,
    ( SELECT max(x.decided_at) AS max
           FROM billing_reviews x
          WHERE x.order_id = b.order_id AND x.company_id = b.company_id) AS last_acknowledged_at,
    h.id AS handoff_order_id,
    h.handoff_id,
    hb.batch_number,
    hb.reference AS handoff_reference,
    hb.created_at AS handed_off_at,
    hb.created_by AS handed_off_by,
    h.id IS NOT NULL AND h.documents_fingerprint <> b.documents_fingerprint AS changed_since_handoff,
        CASE
            WHEN h.id IS NOT NULL THEN 'handed_off'::text
            WHEN b.loads_missing > 0 OR b.status = 'completed'::order_status AND b.tickets_live = 0 THEN 'missing_documentation'::text
            WHEN b.tickets_pending > 0 THEN 'needs_review'::text
            WHEN b.exceptions_count > 0 AND r.id IS NULL THEN 'blocked'::text
            WHEN b.status <> 'completed'::order_status AND NOT COALESCE(f.fulfilled, false) THEN 'in_progress'::text
            ELSE 'ready'::text
        END AS readiness,
    COALESCE(f.fulfilled, false) AS fulfilled,
    f.gap AS fulfillment_gap
   FROM base b
     LEFT JOIN order_fulfillment f ON f.order_id = b.order_id AND f.company_id = b.company_id
     LEFT JOIN LATERAL ( SELECT x.id,
            x.company_id,
            x.order_id,
            x.fingerprint,
            x.exceptions,
            x.reason,
            x.decided_by,
            x.decided_at
           FROM billing_reviews x
          WHERE x.order_id = b.order_id AND x.company_id = b.company_id AND x.fingerprint = b.exceptions_fingerprint
          ORDER BY x.decided_at DESC
         LIMIT 1) r ON b.exceptions_count > 0
     LEFT JOIN billing_handoff_orders h ON h.order_id = b.order_id AND h.company_id = b.company_id AND h.reverted_at IS NULL
     LEFT JOIN billing_handoffs hb ON hb.id = h.handoff_id AND hb.company_id = h.company_id;
grant select, insert, update, delete on public.billing_order_status to authenticated;
grant all on public.billing_order_status to service_role;

drop function if exists public.demo_price_check_sample(uuid);
drop function if exists public.order_confirm_price(uuid, text);
drop function if exists private.require_prices_checked(uuid[]);
drop function if exists private.order_price_check_after_save(uuid);
drop function if exists private.order_price_fingerprint(uuid, uuid);

alter table public.orders drop constraint if exists orders_price_check_order;
alter table public.orders
  drop column if exists price_check_requested_at,
  drop column if exists price_check_requested_by,
  drop column if exists price_check_fingerprint,
  drop column if exists price_checked_at,
  drop column if exists price_checked_by,
  drop column if exists price_check_note;
alter table public.order_lines drop column if exists price_entered_by;

notify pgrst, 'reload schema';

commit;
