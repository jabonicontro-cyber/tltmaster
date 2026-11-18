-- Rollback of 20261120024700_order_totals_money_only (SEC7). Run with psql -v ON_ERROR_STOP=1 -1 -f.
--   * public.orders, order_lines, quote_versions and quote_lines readable as whole tables again (totals included).
--   * The read views, customer_history and dispatch_base_summary read the totals straight from the tables again.
--   * The order and quote history policies are as before (every entry readable with orders.view / quotes.view).
--   * The new functions go; the app then shows no totals where it reads them through order_totals and the like, and
--     reads the history straight from the table.
-- No rows change.
begin;

do $$
declare
  t text;
  v_cols text;
begin
  foreach t in array array['orders', 'order_lines', 'quote_versions', 'quote_lines'] loop
    select string_agg(quote_ident(a.attname), ', ' order by a.attnum) into v_cols
      from pg_attribute a
     where a.attrelid = format('public.%I', t)::regclass and a.attnum > 0 and not a.attisdropped;
    execute format('revoke select (%s) on public.%I from authenticated', v_cols, t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end;
$$;

create or replace view public.order_list with (security_invoker = true) as
SELECT o.id,
    o.order_number,
    o.status,
    o.customer_id,
    c.name AS customer_name,
    c.customer_number,
    o.source_quote_id,
    q.quote_number AS source_quote_number,
    o.project_name,
    o.site_label,
    o.site_line1,
    o.site_city,
    o.customer_po,
    o.total_cents,
    o.is_sample,
    o.created_at,
    o.company_id,
    o.order_date,
    o.requested_date,
    o.scheduled_start,
    o.scheduled_end,
    o.window_start,
    o.window_end,
    o.contact_name,
    o.status_note,
    o.updated_at,
    ( SELECT string_agg(l.description, ', '::text ORDER BY l.line_no) AS string_agg
           FROM order_lines l
          WHERE l.order_id = o.id AND l.kind = 'material'::charge_kind) AS material_summary,
    o.base_id
   FROM orders o
     JOIN customers c ON c.id = o.customer_id
     LEFT JOIN quotes q ON q.id = o.source_quote_id;

create or replace view public.quote_list with (security_invoker = true) as
SELECT q.id,
    q.quote_number,
    q.status,
    q.customer_id,
    c.name AS customer_name,
    c.customer_number,
    q.is_sample,
    q.created_at,
    q.updated_at,
    q.first_sent_at,
    q.last_sent_at,
    q.accepted_at,
    v.id AS version_id,
    v.version_no,
    v.quote_date,
    v.valid_until,
    v.project_name,
    v.site_label,
    v.site_line1,
    v.site_city,
    v.total_cents,
    v.locked_at
   FROM quotes q
     JOIN customers c ON c.id = q.customer_id
     JOIN quote_versions v ON v.id = q.current_version_id;

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
            WHEN ol.price_entered_by IS NOT NULL AND o.price_check_requested_at IS NOT NULL AND o.price_checked_at IS NULL THEN 'manual_price'::text
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
  WHERE ol.calc_method = 'per_unit'::calc_method AND ol.kind <> 'discount'::charge_kind AND NOT (EXISTS ( SELECT 1
           FROM charge_items ci
          WHERE ci.id = ol.charge_item_id AND ci.company_id = ol.company_id AND NOT ci.ticket_required)) AND (o.status = ANY (ARRAY['scheduled'::order_status, 'dispatched'::order_status, 'in_progress'::order_status, 'partially_completed'::order_status, 'completed'::order_status]));

create or replace view public.billing_order_status with (security_invoker = true) as
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
            COALESCE(e.exceptions_fingerprint, md5(''::text)) AS exceptions_fingerprint,
            o.price_check_requested_at IS NOT NULL AND o.price_checked_at IS NULL AS price_check_pending
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
            WHEN b.exceptions_count > 0 AND r.id IS NULL OR b.price_check_pending THEN 'blocked'::text
            WHEN b.status <> 'completed'::order_status AND NOT COALESCE(f.fulfilled, false) THEN 'in_progress'::text
            ELSE 'ready'::text
        END AS readiness,
    COALESCE(f.fulfilled, false) AS fulfilled,
    f.gap AS fulfillment_gap,
    b.price_check_pending
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

create or replace function public.customer_history(p_customer uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  with o as (
    select id, order_number, status, order_date, total_cents from public.orders where customer_id = p_customer
  ), t as (
    select d.unit_code, d.quantity, d.delivered_at from public.delivery_tickets d
    where d.order_id in (select id from o) and d.status = 'accepted'
  ), q as (
    select status from public.quotes where customer_id = p_customer
  )
  select jsonb_build_object(
    'orders', (select count(*) from o where status <> 'canceled'),
    'open_orders', (select count(*) from o where status not in ('completed', 'canceled')),
    'first_order_on', (select min(order_date) from o where status <> 'canceled'),
    'last_order_on', (select max(order_date) from o where status <> 'canceled'),
    'ordered_cents_365d', (select coalesce(sum(total_cents), 0) from o where status <> 'canceled' and order_date > current_date - 365),
    'accepted_tickets', (select count(*) from t),
    'delivered_365d', (select coalesce(jsonb_object_agg(unit_code, qty), '{}') from (select unit_code, sum(quantity) qty from t where delivered_at > now() - interval '365 days' group by unit_code) x),
    'quotes', jsonb_build_object(
      'open', (select count(*) from q where status in ('draft', 'sent')),
      'accepted', (select count(*) from q where status = 'accepted'),
      'decided', (select count(*) from q where status in ('accepted', 'declined', 'expired'))),
    'recent_orders', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'order_number', order_number, 'status', status, 'order_date', order_date, 'total_cents', total_cents) order by order_date desc, order_number desc), '[]')
                      from (select * from o order by order_date desc, order_number desc limit 10) r),
    'quiet', (select max(order_date) < current_date - 90 from o where status <> 'canceled')
  );
$$;

create or replace function public.dispatch_base_summary(p_from date, p_to date)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', b.id, 'code', b.code, 'name', b.name, 'active', b.active, 'is_default', b.is_default,
    'trucks', (select count(*) from public.trucks t where t.base_id = b.id and t.active),
    'trucks_available', (select count(*) from public.trucks t where t.base_id = b.id and t.active and t.service_status = 'in_service'),
    'drivers', (select count(*) from public.drivers d where d.base_id = b.id and d.active),
    'orders', (select count(*) from public.orders o where o.base_id = b.id and o.order_date between p_from and p_to and o.status <> 'canceled'),
    'loads', (select count(*) from public.order_loads l join public.orders o on o.id = l.order_id where o.base_id = b.id and l.load_date between p_from and p_to and l.status <> 'canceled'),
    'ordered_cents', (select coalesce(sum(o.total_cents), 0) from public.orders o where o.base_id = b.id and o.order_date between p_from and p_to and o.status <> 'canceled'))
    order by b.is_default desc, b.code), '[]')
  from public.dispatch_bases b;
$$;

drop policy if exists audit_read_orders on public.audit_events;
create policy audit_read_orders on public.audit_events for select to authenticated
  using (company_id = (select private.current_company_id())
         and entity_type = 'order'
         and (select private.has_permission('orders.view'))
         and (action not like 'billing.%' or (select private.has_permission('billing.view'))));

drop policy if exists audit_read_quotes on public.audit_events;
create policy audit_read_quotes on public.audit_events for select to authenticated
  using (company_id = (select private.current_company_id())
         and entity_type = 'quote'
         and (select private.has_permission('quotes.view')));

-- save_order_draft and save_quote_draft answer with the total for everyone again (before private.sales_money_ok goes).
do $$
declare
  r record;
  v_def text;
begin
  for r in select * from (values
      ('public.save_order_draft(jsonb)'::regprocedure, $old$    'total_cents', case when private.sales_money_ok() then v_order.total_cents end);$old$,
       $new$    'total_cents', v_order.total_cents);$new$),
      ('public.save_quote_draft(jsonb)'::regprocedure, $old$    'total_cents', case when private.sales_money_ok() then v_version.total_cents end);$old$,
       $new$    'total_cents', v_version.total_cents);$new$)) as t(fn, old_text, new_text)
  loop
    v_def := pg_get_functiondef(r.fn);
    if position(r.old_text in v_def) > 0 then
      execute replace(v_def, r.old_text, r.new_text);
    end if;
  end loop;
end;
$$;

drop function if exists public.sales_history(text, uuid);
drop function if exists private.sales_history_money_action(text);
drop function if exists public.order_totals(uuid[]);
drop function if exists public.order_line_amounts(uuid[]);
drop function if exists public.quote_totals(uuid[]);
drop function if exists public.quote_line_amounts(uuid[]);
drop function if exists private.order_total_cents(uuid);
drop function if exists private.order_line_amount_cents(uuid);
drop function if exists private.quote_version_total_cents(uuid);
drop function if exists private.visible_order_totals();
drop function if exists private.visible_order_line_amounts();
drop function if exists private.visible_quote_totals();
drop function if exists private.sales_money_ok();

notify pgrst, 'reload schema';

commit;
