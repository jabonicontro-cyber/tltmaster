-- =============================================================================
-- Order and quote totals for money access only (owner decision 2026-11-14 to 11-17, master plan §12 SEC7; CLAUDE.md
-- "Security first, above all for financial data").
--
-- Owner: "Dispatchers without billing/pricing access: hide order totals, revenue estimates and invoice amounts; keep the
-- per-unit rates they type." Until now anyone who could read orders (orders.view, so dispatchers) could read each
-- order's subtotal, tax and total and each line's amount through the REST API, and the same for quotes (quotes.view,
-- which the default dispatcher holds) and the history of both ("ORD-1038 created: total 610.00"). Invoices were already
-- billing.view only (20261120004800). Now:
--
--   * "Money access" for sales totals is private.sales_money_ok(): billing.view, billing.manage, pricing.edit or
--     pricing.override (the owner, office and outside accountant by default; never a dispatcher, mechanic or driver).
--   * public.orders, public.order_lines, public.quote_versions and public.quote_lines are readable column by column:
--     every column except the totals (orders and quote versions: subtotal, discount, taxable, tax, total) and each line's
--     amount. The per-unit rate, percent, price-list rate, quantity and description stay readable, so a dispatcher still
--     sees and types the rates on the orders they enter (their typed prices are checked by the office, MD1). The grant
--     lists the columns that exist when this runs; a column added later needs its own grant (docs/SCHEMA.md). Row rules
--     (RLS) are unchanged.
--   * The read views order_list, billing_order_status, billing_line_status and quote_list keep every column; their total
--     and amount columns are empty (null) for people without money access, and filled through the definer helpers below
--     for those with it.
--   * public.order_totals / order_line_amounts / quote_totals / quote_line_amounts return the figures to people with
--     money access only (42501 otherwise), only for records the person may read anyway (company, orders.view or
--     quotes.view, and the order's base for base-limited people).
--   * customer_history (customer page) and dispatch_base_summary (bases page) leave their money figures empty for people
--     without money access.
--   * History: entries that carry a total (order created / created from a quote / saved / price checks, quote created
--     and saved) are no longer readable straight from audit_events without money access; public.sales_history(type, id)
--     returns the whole history of one order or quote, with the totals taken out for people without money access.
--
-- Writing is unchanged: orders and quotes are saved through their security definer functions (save_order_draft,
-- save_quote_draft, order_confirm_price, ...), which compute and store the totals themselves. A Taviron support visit
-- has the owner's permissions while the owner's grant lasts; a demo role preview narrows permissions in the app only,
-- and the app asks for totals only when the previewed role has money access (src/lib/permissions.ts canSeeSalesTotals).
-- The customer portal reads through its own portal_* definer functions and is unaffected.
--
-- No rows change. Works with the code before it only partly: the earlier app read the totals straight from the tables,
-- so this migration ships together with the app that reads them through these functions (owner-items-c).
-- Reversible: supabase/rollbacks/20261120024700_order_totals_money_only.down.sql
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Who may see sales totals
-- -----------------------------------------------------------------------------
create or replace function private.sales_money_ok()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.has_permission('billing.view') or private.has_permission('billing.manage')
      or private.has_permission('pricing.edit') or private.has_permission('pricing.override');
$$;

-- The company's figures, once per query, for the read views and the customer and bases summaries (which run as the
-- person reading them): every order total, line amount or quote version total of the caller's company when they have
-- money access, and no rows otherwise. The permission is checked once per call (a one-time filter), not per row.
create or replace function private.visible_order_totals()
returns table (order_id uuid, total_cents bigint)
language sql
stable
security definer
set search_path = ''
as $$
  select o.id, o.total_cents from public.orders o
   where o.company_id = private.current_company_id() and private.sales_money_ok();
$$;

create or replace function private.visible_order_line_amounts()
returns table (line_id uuid, amount_cents bigint)
language sql
stable
security definer
set search_path = ''
as $$
  select l.id, l.amount_cents from public.order_lines l
   where l.company_id = private.current_company_id() and private.sales_money_ok();
$$;

create or replace function private.visible_quote_totals()
returns table (version_id uuid, total_cents bigint)
language sql
stable
security definer
set search_path = ''
as $$
  select v.id, v.total_cents from public.quote_versions v
   where v.company_id = private.current_company_id() and private.sales_money_ok();
$$;

revoke all on function private.sales_money_ok(), private.visible_order_totals(), private.visible_order_line_amounts(),
  private.visible_quote_totals() from public, anon;
grant execute on function private.sales_money_ok(), private.visible_order_totals(), private.visible_order_line_amounts(),
  private.visible_quote_totals() to authenticated;

-- -----------------------------------------------------------------------------
-- Read views: same columns, totals only with money access
-- -----------------------------------------------------------------------------
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
    vt.total_cents,
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
     LEFT JOIN quotes q ON q.id = o.source_quote_id
     LEFT JOIN private.visible_order_totals() vt ON vt.order_id = o.id;

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
    vt.total_cents,
    v.locked_at
   FROM quotes q
     JOIN customers c ON c.id = q.customer_id
     JOIN quote_versions v ON v.id = q.current_version_id
     LEFT JOIN private.visible_quote_totals() vt ON vt.version_id = v.id;

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
    va.amount_cents,
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
     LEFT JOIN private.visible_order_line_amounts() va ON va.line_id = ol.id
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
            vt.total_cents,
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
             LEFT JOIN private.visible_order_totals() vt ON vt.order_id = o.id
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

-- -----------------------------------------------------------------------------
-- Column-level read access (after the views, which no longer read the money columns themselves)
-- -----------------------------------------------------------------------------
do $$
declare
  r record;
  v_cols text;
begin
  for r in select * from (values
      ('orders', array['subtotal_cents', 'discount_cents', 'taxable_cents', 'tax_cents', 'total_cents']),
      ('order_lines', array['amount_cents']),
      ('quote_versions', array['subtotal_cents', 'discount_cents', 'taxable_cents', 'tax_cents', 'total_cents']),
      ('quote_lines', array['amount_cents'])) as t(tbl, hidden)
  loop
    select string_agg(quote_ident(a.attname), ', ' order by a.attnum) into v_cols
      from pg_attribute a
     where a.attrelid = format('public.%I', r.tbl)::regclass and a.attnum > 0 and not a.attisdropped
       and a.attname <> all (r.hidden);
    execute format('revoke select on public.%I from authenticated', r.tbl);
    execute format('grant select (%s) on public.%I to authenticated', v_cols, r.tbl);
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- Customer and bases summaries: money figures only with money access
-- -----------------------------------------------------------------------------
create or replace function public.customer_history(p_customer uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  with m as (
    select private.sales_money_ok() as ok
  ), o as (
    select o.id, o.order_number, o.status, o.order_date, vt.total_cents
      from public.orders o
      left join private.visible_order_totals() vt on vt.order_id = o.id
     where o.customer_id = p_customer
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
    'ordered_cents_365d', case when (select ok from m)
                               then (select coalesce(sum(total_cents), 0) from o where status <> 'canceled' and order_date > current_date - 365) end,
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
    'ordered_cents', case when (select private.sales_money_ok())
                          then (select coalesce(sum(vt.total_cents), 0) from public.orders o
                                 join private.visible_order_totals() vt on vt.order_id = o.id
                                 where o.base_id = b.id and o.order_date between p_from and p_to and o.status <> 'canceled') end)
    order by b.is_default desc, b.code), '[]')
  from public.dispatch_bases b;
$$;

-- -----------------------------------------------------------------------------
-- The figures, for people with money access
-- -----------------------------------------------------------------------------
-- Orders the person may read anyway: their company, orders.view, and (for base-limited people) the order's base, as the
-- orders_base_access policy says.
create or replace function public.order_totals(p_orders uuid[])
returns table (order_id uuid, subtotal_cents bigint, discount_cents bigint, taxable_cents bigint, tax_cents bigint, total_cents bigint)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v_bases uuid[] := private.my_bases();
begin
  if not private.has_permission('orders.view') or not private.sales_money_ok() then
    raise exception 'Only people who can see billing or prices can see order totals.' using errcode = '42501';
  end if;
  return query
    select o.id, o.subtotal_cents, o.discount_cents, o.taxable_cents, o.tax_cents, o.total_cents
      from public.orders o
     where o.company_id = v_company and o.id = any (coalesce(p_orders, '{}'))
       and (v_bases is null or o.base_id is null or o.base_id = any (v_bases));
end;
$$;

create or replace function public.order_line_amounts(p_orders uuid[])
returns table (line_id uuid, order_id uuid, amount_cents bigint)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v_bases uuid[] := private.my_bases();
begin
  if not private.has_permission('orders.view') or not private.sales_money_ok() then
    raise exception 'Only people who can see billing or prices can see line amounts.' using errcode = '42501';
  end if;
  return query
    select l.id, l.order_id, l.amount_cents
      from public.order_lines l
      join public.orders o on o.id = l.order_id and o.company_id = l.company_id
     where l.company_id = v_company and l.order_id = any (coalesce(p_orders, '{}'))
       and (v_bases is null or o.base_id is null or o.base_id = any (v_bases))
     order by l.order_id, l.line_no;
end;
$$;

create or replace function public.quote_totals(p_versions uuid[])
returns table (version_id uuid, subtotal_cents bigint, discount_cents bigint, taxable_cents bigint, tax_cents bigint, total_cents bigint)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
begin
  if not private.has_permission('quotes.view') or not private.sales_money_ok() then
    raise exception 'Only people who can see billing or prices can see quote totals.' using errcode = '42501';
  end if;
  return query
    select v.id, v.subtotal_cents, v.discount_cents, v.taxable_cents, v.tax_cents, v.total_cents
      from public.quote_versions v
     where v.company_id = v_company and v.id = any (coalesce(p_versions, '{}'));
end;
$$;

create or replace function public.quote_line_amounts(p_versions uuid[])
returns table (line_id uuid, version_id uuid, amount_cents bigint)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
begin
  if not private.has_permission('quotes.view') or not private.sales_money_ok() then
    raise exception 'Only people who can see billing or prices can see line amounts.' using errcode = '42501';
  end if;
  return query
    select l.id, l.quote_version_id, l.amount_cents
      from public.quote_lines l
     where l.company_id = v_company and l.quote_version_id = any (coalesce(p_versions, '{}'))
     order by l.quote_version_id, l.line_no;
end;
$$;

revoke all on function public.order_totals(uuid[]), public.order_line_amounts(uuid[]), public.quote_totals(uuid[]),
  public.quote_line_amounts(uuid[]) from public, anon;
grant execute on function public.order_totals(uuid[]), public.order_line_amounts(uuid[]), public.quote_totals(uuid[]),
  public.quote_line_amounts(uuid[]) to authenticated;

-- -----------------------------------------------------------------------------
-- History: entries carrying a total, read through sales_history without money access
-- -----------------------------------------------------------------------------
create or replace function private.sales_history_money_action(p_action text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_action in ('order.created', 'order.created_from_quote', 'order.updated', 'order.price_check_requested',
                      'order.price_checked', 'order.price_corrected', 'quote.created', 'quote.updated');
$$;

grant execute on function private.sales_history_money_action(text) to authenticated;

drop policy if exists audit_read_orders on public.audit_events;
create policy audit_read_orders on public.audit_events for select to authenticated
  using (company_id = (select private.current_company_id())
         and entity_type = 'order'
         and (select private.has_permission('orders.view'))
         and (action not like 'billing.%' or (select private.has_permission('billing.view')))
         and (not private.sales_history_money_action(action) or (select private.sales_money_ok())));

drop policy if exists audit_read_quotes on public.audit_events;
create policy audit_read_quotes on public.audit_events for select to authenticated
  using (company_id = (select private.current_company_id())
         and entity_type = 'quote'
         and (select private.has_permission('quotes.view'))
         and (not private.sales_history_money_action(action) or (select private.sales_money_ok())));

-- The history of one order or quote, newest first (at most 100 entries), for people who may read it (orders.view and the
-- order's base, or quotes.view; billing entries only with billing.view, as the policies say). Without money access the
-- totals are taken out of the entries that carry one: ": total 610.00" from the summary, total_cents and the like from
-- the details. Everything else reads as stored.
create or replace function public.sales_history(p_entity_type text, p_entity_id uuid)
returns setof public.audit_events
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v_bases uuid[] := private.my_bases();
  v_money boolean := private.sales_money_ok();
  v_billing boolean := private.has_permission('billing.view');
begin
  if p_entity_type = 'order' then
    if not private.has_permission('orders.view') then
      raise exception 'You do not have permission to see orders.' using errcode = '42501';
    end if;
    if not exists (select 1 from public.orders o where o.id = p_entity_id and o.company_id = v_company
                     and (v_bases is null or o.base_id is null or o.base_id = any (v_bases))) then
      return;
    end if;
  elsif p_entity_type = 'quote' then
    if not private.has_permission('quotes.view') then
      raise exception 'You do not have permission to see quotes.' using errcode = '42501';
    end if;
  else
    raise exception 'Only the history of an order or a quote is read here.' using errcode = '22023';
  end if;
  return query
    select e.id, e.occurred_at, e.actor_id, e.action, e.entity_type, e.entity_id,
           case when v_money or not private.sales_history_money_action(e.action) then e.summary
                else regexp_replace(e.summary, '[:,]\s*total\s+-?[0-9][0-9,]*\.[0-9]{2}', '', 'g') end,
           case when v_money or not private.sales_history_money_action(e.action) or jsonb_typeof(e.details) <> 'object' then e.details
                else (e.details - 'total_cents' - 'subtotal_cents' - 'tax_cents' - 'total_from' - 'total_to')
                     || case when jsonb_typeof(e.details -> 'changes') = 'object'
                             then jsonb_build_object('changes', (e.details -> 'changes') - 'total_cents' - 'subtotal_cents' - 'tax_cents' - 'discount_cents' - 'taxable_cents')
                             else '{}'::jsonb end end,
           e.company_id
      from public.audit_events e
     where e.company_id = v_company and e.entity_type = p_entity_type and e.entity_id = p_entity_id
       and (e.action not like 'billing.%' or v_billing)
     order by e.occurred_at desc
     limit 100;
end;
$$;

revoke all on function public.sales_history(text, uuid) from public, anon;
grant execute on function public.sales_history(text, uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- Saving an order or a quote: the answer carries the new total only for people with money access
-- -----------------------------------------------------------------------------
-- save_order_draft (orders.create: dispatchers enter phoned-in orders) and save_quote_draft answer with the saved
-- total; the Command Center's unscheduled-order item carries it in its details. Their bodies are long and otherwise unchanged, so only the final answer is narrowed, in place: the saved
-- definition gets 'total_cents' only when private.sales_money_ok(). Each replacement must match exactly once.
do $$
declare
  r record;
  v_def text;
  v_new text;
begin
  for r in select * from (values
      ('public.save_order_draft(jsonb)'::regprocedure, $old$    'total_cents', v_order.total_cents);$old$,
       $new$    'total_cents', case when private.sales_money_ok() then v_order.total_cents end);$new$),
      ('public.save_quote_draft(jsonb)'::regprocedure, $old$    'total_cents', v_version.total_cents);$old$,
       $new$    'total_cents', case when private.sales_money_ok() then v_version.total_cents end);$new$),
      -- The Command Center's "needs a delivery date" item carried the order total in its details (read by dispatchers).
      ('private.operational_exceptions_all(uuid)'::regprocedure, $old$'project_name', o.project_name, 'total_cents', o.total_cents)$old$,
       $new$'project_name', o.project_name, 'total_cents', case when private.sales_money_ok() then o.total_cents end)$new$)) as t(fn, old_text, new_text)
  loop
    v_def := pg_get_functiondef(r.fn);
    if (length(v_def) - length(replace(v_def, r.old_text, ''))) / length(r.old_text) <> 1 then
      raise exception 'The answer of % is not as expected; nothing was changed.', r.fn;
    end if;
    v_new := replace(v_def, r.old_text, r.new_text);
    execute v_new;
  end loop;
end;
$$;

notify pgrst, 'reload schema';

-- Verification
do $$
begin
  if has_column_privilege('authenticated', 'public.orders', 'total_cents', 'select')
     or has_column_privilege('authenticated', 'public.orders', 'subtotal_cents', 'select')
     or has_column_privilege('authenticated', 'public.orders', 'tax_cents', 'select')
     or has_column_privilege('authenticated', 'public.order_lines', 'amount_cents', 'select')
     or has_column_privilege('authenticated', 'public.quote_versions', 'total_cents', 'select')
     or has_column_privilege('authenticated', 'public.quote_lines', 'amount_cents', 'select')
     or has_table_privilege('authenticated', 'public.orders', 'select')
     or not has_column_privilege('authenticated', 'public.order_lines', 'unit_rate_cents', 'select')
     or not has_column_privilege('authenticated', 'public.order_lines', 'catalog_rate_cents', 'select')
     or not has_column_privilege('authenticated', 'public.quote_lines', 'unit_rate_cents', 'select')
     or not has_column_privilege('authenticated', 'public.orders', 'order_number', 'select')
     or not has_column_privilege('authenticated', 'public.orders', 'tax_rate_bp', 'select') then
    raise exception 'Order and quote column access is not as intended.';
  end if;
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where (n.nspname, p.proname) in (('private', 'sales_money_ok'), ('private', 'visible_order_totals'), ('private', 'visible_order_line_amounts'),
                                     ('private', 'visible_quote_totals'), ('public', 'order_totals'), ('public', 'order_line_amounts'),
                                     ('public', 'quote_totals'), ('public', 'quote_line_amounts'), ('public', 'sales_history'))
      and not (p.prosecdef and coalesce(p.proconfig, '{}') @> array['search_path=""']))
  then
    raise exception 'A new function is not a pinned security definer function.';
  end if;
  if (select count(*) from pg_proc where oid in ('public.save_order_draft(jsonb)'::regprocedure, 'public.save_quote_draft(jsonb)'::regprocedure,
                                                'private.operational_exceptions_all(uuid)'::regprocedure)
        and prosrc like '%private.sales_money_ok()%' and prosecdef and coalesce(proconfig, '{}') @> array['search_path=""']) <> 3 then
    raise exception 'save_order_draft and save_quote_draft do not narrow their answer as intended.';
  end if;
end;
$$;
