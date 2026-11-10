-- =============================================================================
-- "Price to be checked" (financial review M1, owner decision 2026-11-10, master plan §12 SEC4).
--
-- With orders.create (dispatchers, by default) and without orders.edit a person enters a phoned-in order themselves
-- (20261120009900). The review found they could type any price on a line without a price-list rate and change the
-- sales tax, then confirm the order, and nothing flagged it at billing. The owner decided:
--   * They may still type a price on a line that has no price-list rate, so an urgent job is not held up.
--   * Tax follows the customer and company settings: they cannot change the order's tax rate from the company default
--     (Settings) or a line's "taxable" from the material's or charge's default. Refused in
--     private.require_order_draft_save, which save_order_draft already calls first.
--   * An order with a price they typed is flagged "Price to be checked". Who typed it is kept on the order
--     (price_check_requested_by/at) and on each such line (order_lines.price_entered_by).
--   * It cannot be handed off for billing or invoiced until someone with pricing.edit, pricing.override or
--     billing.manage confirms the price (public.order_confirm_price), recorded in the order's history (audit event
--     order.price_checked). Billing readiness shows it: billing_order_status.price_check_pending (new last column)
--     keeps the order "blocked", and billing_line_status.pricing_check reads 'manual_price' on such lines.
--     Taviron support visits cannot confirm a price (a money decision stays with the company's own people).
--   * People who may change orders or decide prices (orders.edit, pricing.edit, pricing.override, billing.manage)
--     price lines exactly as before: nothing is flagged for them.
--
-- How existing objects change:
--   * private.require_order_draft_save: replaced (it only has this job), the tax checks added for orders.create only.
--   * save_order_draft: one line added before the totals are computed (private.order_price_check_after_save), patched
--     from the installed definition; hand_off_orders, invoice_create and invoice_create_combined: one check added
--     (private.require_prices_checked). Each anchor line must appear exactly once, or the migration stops.
--   * billing_line_status and billing_order_status: same columns (one added at the end of billing_order_status), from
--     their latest definitions (20261120008200, 20261120001900).
-- New columns are nullable or have a default; no existing row changes.
-- Reversible: supabase/rollbacks/20261120016100_order_price_check.down.sql
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Who typed a price, and who confirmed it
-- -----------------------------------------------------------------------------
alter table public.order_lines
  add column if not exists price_entered_by uuid references auth.users (id) on delete set null;

alter table public.orders
  add column if not exists price_check_requested_at timestamptz,
  add column if not exists price_check_requested_by uuid references auth.users (id) on delete set null,
  add column if not exists price_check_fingerprint text,
  add column if not exists price_checked_at timestamptz,
  add column if not exists price_checked_by uuid references auth.users (id) on delete set null,
  add column if not exists price_check_note text not null default '' check (length(price_check_note) <= 500);

alter table public.orders drop constraint if exists orders_price_check_order;
alter table public.orders add constraint orders_price_check_order
  check (price_checked_at is null or price_check_requested_at is not null);

comment on column public.orders.price_check_requested_by is
  'Who typed a price without a price-list rate (orders.create without orders.edit); billing waits until it is confirmed.';
comment on column public.order_lines.price_entered_by is
  'Who typed this line''s price without a price-list rate (orders.create without orders.edit).';

-- -----------------------------------------------------------------------------
-- 2. Saving a draft with orders.create only: tax follows the settings
-- -----------------------------------------------------------------------------
-- As 20261120009900, plus for orders.create without orders.edit: the order's tax rate must be the company's default
-- (Settings; any rate for a tax-exempt customer, whose tax is always 0) and each line's "taxable" must be the default
-- of its material or charge (a line without one: not taxable).
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
  v_exempt   boolean;
  v_default  integer;
  v_line     jsonb;
  v_no       integer := 0;
  v_taxable  boolean;
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

  -- Sales tax follows the customer and company settings (owner 2026-11-10, M1).
  select c.tax_exempt into v_exempt from public.customers c where c.id = v_customer and c.company_id = v_company;
  select coalesce(s.default_tax_rate_bp, 0) into v_default from public.company_settings s where s.company_id = v_company;
  v_default := coalesce(v_default, 0);
  if not coalesce(v_exempt, false)
     and coalesce(nullif(p_payload ->> 'tax_rate_bp', '')::integer, 0) <> v_default then
    raise exception 'Sales tax follows the company setting (%). Someone who can change orders can use another rate on this order.',
      to_char(v_default / 100.0, 'FM990.00') || '%' using errcode = '42501';
  end if;
  if jsonb_typeof(p_payload -> 'lines') = 'array' then
    for v_line in select value from jsonb_array_elements(p_payload -> 'lines') loop
      v_no := v_no + 1;
      v_taxable := coalesce(
        (select m.taxable_default from public.materials m where m.id = nullif(v_line ->> 'material_id', '')::uuid and m.company_id = v_company),
        (select ci.taxable_default from public.charge_items ci where ci.id = nullif(v_line ->> 'charge_item_id', '')::uuid and ci.company_id = v_company),
        false);
      if coalesce((v_line ->> 'taxable')::boolean, false) is distinct from v_taxable then
        raise exception 'Line %: whether it is taxed follows the % setting (%). Someone who can change orders can change it.',
          v_no,
          case when nullif(v_line ->> 'material_id', '') is not null then 'material'
               when nullif(v_line ->> 'charge_item_id', '') is not null then 'charge'
               else 'company' end,
          case when v_taxable then 'taxable' else 'not taxable' end
          using errcode = '42501';
      end if;
    end loop;
  end if;
end;
$$;

revoke all on function private.require_order_draft_save(jsonb) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 3. After the lines are saved: flag a typed price
-- -----------------------------------------------------------------------------
-- Called from public.save_order_draft only (not granted to anyone), after its lines are inserted and before its
-- totals. Lines priced by hand (price_source 'manual': no price-list rate) saved by a person without orders.edit,
-- pricing.edit, pricing.override and billing.manage get price_entered_by; the order is flagged to be checked. A
-- confirmation stays valid while the typed prices are the same (fingerprint); a changed one asks again. When no typed
-- price is left, nothing remains to check.
create or replace function private.order_price_check_after_save(p_order_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_order public.orders%rowtype;
  v_fp    text;
  v_lines jsonb;
begin
  if private.has_permission('orders.edit') or private.has_permission('pricing.edit')
     or private.has_permission('pricing.override') or private.has_permission('billing.manage') then
    return;
  end if;
  select * into v_order from public.orders where id = p_order_id and company_id = private.require_company() for update;
  if not found then
    return;
  end if;
  update public.order_lines set price_entered_by = auth.uid()
   where order_id = v_order.id and company_id = v_order.company_id and price_source = 'manual';

  select md5(string_agg(concat_ws('|', l.kind, l.calc_method, l.material_id, l.charge_item_id, l.unit_code,
                                  l.unit_rate_cents, l.percent_bp, l.description), ','
                        order by concat_ws('|', l.kind, l.calc_method, l.material_id, l.charge_item_id, l.unit_code,
                                           l.unit_rate_cents, l.percent_bp, l.description))),
         jsonb_agg(jsonb_build_object('line_no', l.line_no, 'description', l.description, 'unit_code', l.unit_code,
                                      'unit_rate_cents', l.unit_rate_cents, 'percent_bp', l.percent_bp) order by l.line_no)
    into v_fp, v_lines
    from public.order_lines l
   where l.order_id = v_order.id and l.company_id = v_order.company_id and l.price_entered_by is not null;

  if v_fp is null then
    if v_order.price_check_requested_at is not null then
      update public.orders set price_check_requested_at = null, price_check_requested_by = null, price_check_fingerprint = null,
                               price_checked_at = null, price_checked_by = null, price_check_note = ''
       where id = v_order.id;
      perform private.log_event('order.price_check_cleared', 'order', v_order.id,
        format('%s: no typed price left to check', v_order.order_number), '{}'::jsonb);
    end if;
    return;
  end if;
  if v_order.price_check_fingerprint is not distinct from v_fp and v_order.price_check_requested_at is not null then
    return; -- the same typed prices: an earlier confirmation (or request) still stands
  end if;
  update public.orders set price_check_requested_at = now(), price_check_requested_by = auth.uid(), price_check_fingerprint = v_fp,
                           price_checked_at = null, price_checked_by = null, price_check_note = ''
   where id = v_order.id;
  perform private.log_event('order.price_check_requested', 'order', v_order.id,
    format('%s: price typed on %s without a price-list rate. Price to be checked before billing.', v_order.order_number,
           case when jsonb_array_length(v_lines) = 1 then 'line ' || (v_lines -> 0 ->> 'line_no')
                else 'lines ' || (select string_agg(x ->> 'line_no', ', ') from jsonb_array_elements(v_lines) x) end),
    jsonb_build_object('lines', v_lines));
end;
$$;

revoke all on function private.order_price_check_after_save(uuid) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 4. Billing waits for the check
-- -----------------------------------------------------------------------------
-- Refuses when any of the orders (in the person's company) has a typed price nobody has confirmed. Called from
-- hand_off_orders, invoice_create and invoice_create_combined only (not granted to anyone).
create or replace function private.require_prices_checked(p_order_ids uuid[])
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_list text;
begin
  select string_agg(o.order_number, ', ' order by o.order_number) into v_list
    from public.orders o
   where o.id = any (p_order_ids) and o.company_id = private.require_company()
     and o.price_check_requested_at is not null and o.price_checked_at is null;
  if v_list is not null then
    raise exception 'Price to be checked on order %: a price was typed without a price-list rate. Someone who can set prices or manage billing confirms it on the order first.',
      v_list using errcode = '22023', hint = 'price_check';
  end if;
end;
$$;

revoke all on function private.require_prices_checked(uuid[]) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 5. Confirming the price
-- -----------------------------------------------------------------------------
-- pricing.edit, pricing.override or billing.manage; never during a Taviron support visit. Safe to repeat (an order
-- already confirmed answers confirmed = false). Recorded in the audit log, which the order's History shows.
create or replace function public.order_confirm_price(p_order_id uuid, p_note text default '')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid;
  v_order   public.orders%rowtype;
  v_note    text := private.clean_text(coalesce(p_note, ''), 500, 'Note');
  v_lines   jsonb;
begin
  if not (private.has_permission('pricing.edit') or private.has_permission('pricing.override') or private.has_permission('billing.manage')) then
    raise exception 'Only someone who can set prices or manage billing can confirm a typed price.' using errcode = '42501';
  end if;
  if private.support_company() is not null then
    raise exception 'Taviron support cannot confirm prices. Ask someone at the company who sets prices or manages billing.'
      using errcode = '42501';
  end if;
  v_company := private.require_company();
  select * into v_order from public.orders where id = p_order_id and company_id = v_company for update;
  if not found then
    raise exception 'Order not found.' using errcode = 'P0002';
  end if;
  if v_order.price_check_requested_at is null then
    raise exception 'Order % has no typed price to check.', v_order.order_number using errcode = '22023';
  end if;
  if v_order.price_checked_at is not null then
    return jsonb_build_object('confirmed', false, 'checked_at', v_order.price_checked_at);
  end if;
  if v_order.status = 'canceled' then
    raise exception 'Order % is canceled.', v_order.order_number using errcode = '22023';
  end if;
  update public.orders set price_checked_at = now(), price_checked_by = auth.uid(), price_check_note = v_note
   where id = v_order.id;
  select jsonb_agg(jsonb_build_object('line_no', l.line_no, 'description', l.description, 'unit_code', l.unit_code,
                                      'unit_rate_cents', l.unit_rate_cents, 'percent_bp', l.percent_bp,
                                      'entered_by', l.price_entered_by) order by l.line_no)
    into v_lines
    from public.order_lines l where l.order_id = v_order.id and l.company_id = v_company and l.price_entered_by is not null;
  perform private.log_event('order.price_checked', 'order', v_order.id,
    format('%s: typed price checked and confirmed%s', v_order.order_number, case when v_note <> '' then ': ' || v_note else '' end),
    jsonb_build_object('requested_by', v_order.price_check_requested_by, 'requested_at', v_order.price_check_requested_at,
                       'fingerprint', v_order.price_check_fingerprint, 'lines', coalesce(v_lines, '[]'::jsonb)));
  return jsonb_build_object('confirmed', true, 'checked_at', now());
end;
$$;

revoke all on function public.order_confirm_price(uuid, text) from public, anon;
grant execute on function public.order_confirm_price(uuid, text) to authenticated;

-- -----------------------------------------------------------------------------
-- 6. Point the existing functions at the new steps (one line each)
-- -----------------------------------------------------------------------------
do $$
declare
  v_def text;
  v_patch record;
begin
  for v_patch in
    select * from (values
      ('public.save_order_draft(jsonb)'::regprocedure,
       '  perform private.recompute_order_totals(v_order.id);',
       '  perform private.order_price_check_after_save(v_order.id);
  perform private.recompute_order_totals(v_order.id);'),
      ('public.hand_off_orders(uuid[], text, text, uuid)'::regprocedure,
       '  perform 1 from public.delivery_tickets where order_id = any(v_ids) and company_id = v_company order by id for update;',
       '  perform 1 from public.delivery_tickets where order_id = any(v_ids) and company_id = v_company order by id for update;
  perform private.require_prices_checked(v_ids);'),
      ('public.invoice_create(uuid)'::regprocedure,
       '  o := h.snapshot -> ''order'';',
       '  perform private.require_prices_checked(array[h.order_id]);
  o := h.snapshot -> ''order'';'),
      ('public.invoice_create_combined(uuid[])'::regprocedure,
       '  select count(*) into v_found from public.billing_handoff_orders h where h.id = any (v_ids) and h.company_id = v_company;',
       '  select count(*) into v_found from public.billing_handoff_orders h where h.id = any (v_ids) and h.company_id = v_company;
  perform private.require_prices_checked(array(select h.order_id from public.billing_handoff_orders h where h.id = any (v_ids) and h.company_id = v_company));')
    ) as t(fn, old_line, new_line)
  loop
    v_def := pg_get_functiondef(v_patch.fn);
    if position('private.order_price_check_after_save(' in v_def) > 0 or position('private.require_prices_checked(' in v_def) > 0 then
      continue; -- already patched (re-run)
    end if;
    if (length(v_def) - length(replace(v_def, v_patch.old_line, ''))) / length(v_patch.old_line) <> 1 then
      raise exception '% is not the version this migration expects (its line was not found exactly once).', v_patch.fn;
    end if;
    execute replace(v_def, v_patch.old_line, v_patch.new_line);
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- 7. Billing readiness shows it
-- -----------------------------------------------------------------------------
-- billing_line_status (as 20261120008200): pricing_check reads 'manual_price' on a line whose typed price is still to
-- be checked ($0.00 stays 'zero_rate', which billing_exceptions reports as before).
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
  WHERE ol.calc_method = 'per_unit'::calc_method AND ol.kind <> 'discount'::charge_kind
    AND NOT EXISTS (SELECT 1 FROM charge_items ci WHERE ci.id = ol.charge_item_id AND ci.company_id = ol.company_id AND NOT ci.ticket_required) AND (o.status = ANY (ARRAY['scheduled'::order_status, 'dispatched'::order_status, 'in_progress'::order_status, 'partially_completed'::order_status, 'completed'::order_status]));

-- billing_order_status (as 20261120001900): an order whose typed price is still to be checked is 'blocked' (whatever
-- was acknowledged), and price_check_pending (new, last column) says why.
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

-- -----------------------------------------------------------------------------
-- 8. Demo sample: one phoned-in order whose typed price the office checks
-- -----------------------------------------------------------------------------
-- Demo companies only, by their owner. Marks the given order of the demo (a direct order with a custom line, saved
-- through save_order_draft by the samples) as typed by the demo's dispatcher (or, without one, the owner), exactly as
-- a dispatcher's save would. Once per demo: any order with a price check counts. Nothing is sent.
create or replace function public.demo_price_check_sample(p_order_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_demo  uuid := private.demo_owner_company();
  v_order public.orders%rowtype;
  v_by    uuid;
  v_fp    text;
begin
  if v_demo is null then
    raise exception 'Demo samples are only added to a demo company, by its owner.' using errcode = '42501';
  end if;
  if exists (select 1 from public.orders where company_id = v_demo and price_check_requested_at is not null) then
    return 0;
  end if;
  select * into v_order from public.orders where id = p_order_id and company_id = v_demo and source_quote_id is null;
  if not found or not exists (select 1 from public.order_lines where order_id = v_order.id and company_id = v_demo and price_source = 'manual') then
    return 0;
  end if;
  select m.user_id into v_by from public.company_memberships m
   where m.company_id = v_demo and m.role = 'dispatcher' and m.active order by m.created_at limit 1;
  v_by := coalesce(v_by, auth.uid());
  update public.order_lines set price_entered_by = v_by where order_id = v_order.id and company_id = v_demo and price_source = 'manual';
  select md5(string_agg(concat_ws('|', l.kind, l.calc_method, l.material_id, l.charge_item_id, l.unit_code,
                                  l.unit_rate_cents, l.percent_bp, l.description), ','
                        order by concat_ws('|', l.kind, l.calc_method, l.material_id, l.charge_item_id, l.unit_code,
                                           l.unit_rate_cents, l.percent_bp, l.description)))
    into v_fp from public.order_lines l where l.order_id = v_order.id and l.company_id = v_demo and l.price_entered_by is not null;
  update public.orders set price_check_requested_at = now(), price_check_requested_by = v_by, price_check_fingerprint = v_fp,
                           price_checked_at = null, price_checked_by = null, price_check_note = ''
   where id = v_order.id;
  perform private.log_event('order.price_check_requested', 'order', v_order.id,
    format('%s: price typed without a price-list rate (demo sample). Price to be checked before billing.', v_order.order_number), '{}'::jsonb);
  return 1;
end;
$$;

revoke all on function public.demo_price_check_sample(uuid) from public, anon;
grant execute on function public.demo_price_check_sample(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- Verification
-- -----------------------------------------------------------------------------
do $$
begin
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where (n.nspname, p.proname) in (('private', 'require_order_draft_save'), ('private', 'order_price_check_after_save'),
                                     ('private', 'require_prices_checked'), ('public', 'order_confirm_price'),
                                     ('public', 'demo_price_check_sample'))
      and not (p.prosecdef and coalesce(p.proconfig, '{}') @> array['search_path=""']))
  then
    raise exception 'A new or changed function is not a pinned security definer function.';
  end if;
  if position('private.order_price_check_after_save(' in pg_get_functiondef('public.save_order_draft(jsonb)'::regprocedure)) = 0
     or position('private.require_prices_checked(' in pg_get_functiondef('public.hand_off_orders(uuid[], text, text, uuid)'::regprocedure)) = 0
     or position('private.require_prices_checked(' in pg_get_functiondef('public.invoice_create(uuid)'::regprocedure)) = 0
     or position('private.require_prices_checked(' in pg_get_functiondef('public.invoice_create_combined(uuid[])'::regprocedure)) = 0 then
    raise exception 'A function was not pointed at the price check.';
  end if;
end;
$$;
