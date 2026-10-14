-- Rollback of 20261114000100_billing_views_per_company.sql (not a migration; run by hand with a backup first).
-- Restores the previous definitions of the three views (same columns; only speed differs).
begin;
CREATE OR REPLACE VIEW public.order_fulfillment WITH (security_invoker='true') AS
 WITH loads AS (
         SELECT l_1.order_id,
            (count(*))::integer AS loads_planned,
            (count(*) FILTER (WHERE (l_1.ends_at > now())))::integer AS loads_upcoming,
            (count(*) FILTER (WHERE ((l_1.ends_at <= now()) AND (NOT (EXISTS ( SELECT 1
                   FROM public.delivery_tickets t_1
                  WHERE ((t_1.load_id = l_1.id) AND (t_1.company_id = l_1.company_id) AND (t_1.status = 'accepted'::public.ticket_status))))))))::integer AS loads_without_accepted_ticket
           FROM public.order_loads l_1
          WHERE (l_1.status = 'planned'::public.load_status)
          GROUP BY l_1.order_id
        ), tickets AS (
         SELECT t_1.order_id,
            (count(*) FILTER (WHERE (t_1.status = ANY (ARRAY['submitted'::public.ticket_status, 'needs_review'::public.ticket_status]))))::integer AS pending,
            (count(*) FILTER (WHERE (t_1.status = 'accepted'::public.ticket_status)))::integer AS accepted
           FROM public.delivery_tickets t_1
          WHERE (t_1.status <> 'superseded'::public.ticket_status)
          GROUP BY t_1.order_id
        ), lines AS (
         SELECT ol.order_id,
            (count(*) FILTER (WHERE (x.other_unit > 0)))::integer AS lines_other_unit,
            (count(*) FILTER (WHERE ((x.other_unit = 0) AND (x.accepted_qty < ol.quantity))))::integer AS lines_short
           FROM (public.order_lines ol
             JOIN LATERAL ( SELECT count(*) FILTER (WHERE (t_1.unit_code IS DISTINCT FROM ol.unit_code)) AS other_unit,
                    COALESCE(sum(t_1.quantity) FILTER (WHERE ((t_1.unit_code = ol.unit_code) AND (t_1.status = 'accepted'::public.ticket_status))), (0)::numeric) AS accepted_qty,
                    count(*) AS live
                   FROM public.delivery_tickets t_1
                  WHERE ((t_1.order_line_id = ol.id) AND (t_1.company_id = ol.company_id) AND (t_1.status = ANY (ARRAY['submitted'::public.ticket_status, 'needs_review'::public.ticket_status, 'accepted'::public.ticket_status])))) x ON ((x.live > 0)))
          WHERE ((ol.calc_method = 'per_unit'::public.calc_method) AND (ol.kind <> 'discount'::public.charge_kind))
          GROUP BY ol.order_id
        )
 SELECT o.id AS order_id,
    o.company_id,
    COALESCE(l.loads_planned, 0) AS loads_planned,
    COALESCE(l.loads_upcoming, 0) AS loads_upcoming,
    COALESCE(l.loads_without_accepted_ticket, 0) AS loads_without_accepted_ticket,
    COALESCE(t.pending, 0) AS tickets_pending,
    COALESCE(t.accepted, 0) AS tickets_accepted,
    COALESCE(ln.lines_short, 0) AS lines_short,
    COALESCE(ln.lines_other_unit, 0) AS lines_other_unit,
    ((COALESCE(l.loads_planned, 0) > 0) AND (COALESCE(l.loads_upcoming, 0) = 0) AND (COALESCE(l.loads_without_accepted_ticket, 0) = 0) AND (COALESCE(t.pending, 0) = 0) AND (COALESCE(t.accepted, 0) > 0) AND (COALESCE(ln.lines_short, 0) = 0) AND (COALESCE(ln.lines_other_unit, 0) = 0)) AS fulfilled,
        CASE
            WHEN (COALESCE(l.loads_planned, 0) = 0) THEN 'no_loads'::text
            WHEN (COALESCE(l.loads_upcoming, 0) > 0) THEN 'loads_upcoming'::text
            WHEN (COALESCE(t.pending, 0) > 0) THEN 'tickets_pending'::text
            WHEN (COALESCE(l.loads_without_accepted_ticket, 0) > 0) THEN 'loads_without_accepted_ticket'::text
            WHEN (COALESCE(ln.lines_other_unit, 0) > 0) THEN 'tickets_other_unit'::text
            WHEN (COALESCE(ln.lines_short, 0) > 0) THEN 'quantity_short'::text
            WHEN (COALESCE(t.accepted, 0) = 0) THEN 'no_accepted_tickets'::text
            ELSE NULL::text
        END AS gap
   FROM (((public.orders o
     LEFT JOIN loads l ON ((l.order_id = o.id)))
     LEFT JOIN tickets t ON ((t.order_id = o.id)))
     LEFT JOIN lines ln ON ((ln.order_id = o.id)));
CREATE OR REPLACE VIEW public.billing_exceptions WITH (security_invoker='true') AS
 SELECT l.company_id,
    l.order_id,
    l.exception_kind AS kind,
    l.load_id,
    NULL::uuid AS line_id,
    l.load_number,
    NULL::integer AS line_no,
    l.planned_quantity AS expected_quantity,
    l.delivered_quantity AS actual_quantity,
    l.planned_unit_code AS unit_code,
    l.ticket_units,
    l.quantity_difference AS difference,
    concat_ws(':'::text, 'load', l.load_id, l.quantity_check, l.planned_quantity, l.planned_unit_code, l.delivered_quantity, array_to_string(l.ticket_units, '|'::text)) AS key
   FROM ( SELECT billing_load_status.load_id,
            billing_load_status.company_id,
            billing_load_status.order_id,
            billing_load_status.order_number,
            billing_load_status.order_status,
            billing_load_status.customer_id,
            billing_load_status.customer_name,
            billing_load_status.load_number,
            billing_load_status.load_date,
            billing_load_status.start_time,
            billing_load_status.end_time,
            billing_load_status.ends_at,
            billing_load_status.planned_quantity,
            billing_load_status.planned_unit_code,
            billing_load_status.assignment_id,
            billing_load_status.truck_id,
            billing_load_status.trailer_id,
            billing_load_status.driver_id,
            billing_load_status.is_due,
            billing_load_status.live_count,
            billing_load_status.accepted_count,
            billing_load_status.pending_count,
            billing_load_status.other_unit_count,
            billing_load_status.delivered_quantity,
            billing_load_status.ticket_units,
            billing_load_status.live_numbers,
            billing_load_status.voided_numbers,
            billing_load_status.documentation_state,
            billing_load_status.quantity_check,
            billing_load_status.quantity_difference,
                CASE billing_load_status.quantity_check
                    WHEN 'units_differ'::text THEN 'load_units_differ'::text
                    ELSE 'load_quantity'::text
                END AS exception_kind
           FROM public.billing_load_status
          WHERE (billing_load_status.quantity_check = ANY (ARRAY['over'::text, 'under'::text, 'units_differ'::text]))) l
UNION ALL
 SELECT x.company_id,
    x.order_id,
    x.exception_kind AS kind,
    NULL::uuid AS load_id,
    x.line_id,
    NULL::integer AS load_number,
    x.line_no,
    x.ordered_quantity AS expected_quantity,
    x.delivered_quantity AS actual_quantity,
    x.unit_code,
    x.ticket_units,
        CASE
            WHEN (x.exception_kind = 'line_quantity'::text) THEN x.quantity_difference
            ELSE NULL::numeric
        END AS difference,
    concat_ws(':'::text, 'line', x.line_id, x.exception_kind, x.ordered_quantity, x.unit_code, x.delivered_quantity, x.unit_rate_cents, array_to_string(x.ticket_units, '|'::text)) AS key
   FROM ( SELECT billing_line_status.line_id,
            billing_line_status.company_id,
            billing_line_status.order_id,
            billing_line_status.order_number,
            billing_line_status.order_status,
            billing_line_status.line_no,
            billing_line_status.kind,
            billing_line_status.description,
            billing_line_status.material_id,
            billing_line_status.unit_code,
            billing_line_status.ordered_quantity,
            billing_line_status.unit_rate_cents,
            billing_line_status.amount_cents,
            billing_line_status.price_source,
            billing_line_status.live_count,
            billing_line_status.pending_count,
            billing_line_status.other_unit_count,
            billing_line_status.delivered_quantity,
            billing_line_status.ticket_units,
            billing_line_status.quantity_check,
            billing_line_status.quantity_difference,
            billing_line_status.pricing_check,
            'line_quantity'::text AS exception_kind
           FROM public.billing_line_status
          WHERE (billing_line_status.quantity_check = ANY (ARRAY['over'::text, 'under'::text]))
        UNION ALL
         SELECT billing_line_status.line_id,
            billing_line_status.company_id,
            billing_line_status.order_id,
            billing_line_status.order_number,
            billing_line_status.order_status,
            billing_line_status.line_no,
            billing_line_status.kind,
            billing_line_status.description,
            billing_line_status.material_id,
            billing_line_status.unit_code,
            billing_line_status.ordered_quantity,
            billing_line_status.unit_rate_cents,
            billing_line_status.amount_cents,
            billing_line_status.price_source,
            billing_line_status.live_count,
            billing_line_status.pending_count,
            billing_line_status.other_unit_count,
            billing_line_status.delivered_quantity,
            billing_line_status.ticket_units,
            billing_line_status.quantity_check,
            billing_line_status.quantity_difference,
            billing_line_status.pricing_check,
            'line_units_differ'::text
           FROM public.billing_line_status
          WHERE (billing_line_status.quantity_check = 'units_differ'::text)
        UNION ALL
         SELECT billing_line_status.line_id,
            billing_line_status.company_id,
            billing_line_status.order_id,
            billing_line_status.order_number,
            billing_line_status.order_status,
            billing_line_status.line_no,
            billing_line_status.kind,
            billing_line_status.description,
            billing_line_status.material_id,
            billing_line_status.unit_code,
            billing_line_status.ordered_quantity,
            billing_line_status.unit_rate_cents,
            billing_line_status.amount_cents,
            billing_line_status.price_source,
            billing_line_status.live_count,
            billing_line_status.pending_count,
            billing_line_status.other_unit_count,
            billing_line_status.delivered_quantity,
            billing_line_status.ticket_units,
            billing_line_status.quantity_check,
            billing_line_status.quantity_difference,
            billing_line_status.pricing_check,
            'line_no_tickets'::text
           FROM public.billing_line_status
          WHERE (billing_line_status.quantity_check = 'no_tickets'::text)
        UNION ALL
         SELECT billing_line_status.line_id,
            billing_line_status.company_id,
            billing_line_status.order_id,
            billing_line_status.order_number,
            billing_line_status.order_status,
            billing_line_status.line_no,
            billing_line_status.kind,
            billing_line_status.description,
            billing_line_status.material_id,
            billing_line_status.unit_code,
            billing_line_status.ordered_quantity,
            billing_line_status.unit_rate_cents,
            billing_line_status.amount_cents,
            billing_line_status.price_source,
            billing_line_status.live_count,
            billing_line_status.pending_count,
            billing_line_status.other_unit_count,
            billing_line_status.delivered_quantity,
            billing_line_status.ticket_units,
            billing_line_status.quantity_check,
            billing_line_status.quantity_difference,
            billing_line_status.pricing_check,
            'line_zero_rate'::text
           FROM public.billing_line_status
          WHERE (billing_line_status.pricing_check = 'zero_rate'::text)) x
UNION ALL
 SELECT o.company_id,
    o.id AS order_id,
    'po_missing'::text AS kind,
    NULL::uuid AS load_id,
    NULL::uuid AS line_id,
    NULL::integer AS load_number,
    NULL::integer AS line_no,
    NULL::numeric AS expected_quantity,
    NULL::numeric AS actual_quantity,
    NULL::text AS unit_code,
    NULL::text[] AS ticket_units,
    NULL::numeric AS difference,
    concat_ws(':'::text, 'po', o.id) AS key
   FROM (public.orders o
     JOIN public.customers c ON (((c.id = o.customer_id) AND (c.company_id = o.company_id))))
  WHERE (c.po_required AND (TRIM(BOTH FROM o.customer_po) = ''::text) AND (o.status = ANY (ARRAY['scheduled'::public.order_status, 'dispatched'::public.order_status, 'in_progress'::public.order_status, 'partially_completed'::public.order_status, 'completed'::public.order_status])));
CREATE OR REPLACE VIEW public.billing_order_status WITH (security_invoker='true') AS
 WITH loads AS (
         SELECT billing_load_status.order_id,
            (count(*))::integer AS loads_total,
            (count(*) FILTER (WHERE billing_load_status.is_due))::integer AS loads_due,
            (count(*) FILTER (WHERE (billing_load_status.documentation_state = 'missing'::text)))::integer AS loads_missing,
            (count(*) FILTER (WHERE (billing_load_status.documentation_state = 'not_due'::text)))::integer AS loads_not_due,
            min(billing_load_status.load_date) AS first_load_date,
            max(billing_load_status.load_date) AS last_load_date
           FROM public.billing_load_status
          GROUP BY billing_load_status.order_id
        ), tickets AS (
         SELECT delivery_tickets.order_id,
            (count(*) FILTER (WHERE (delivery_tickets.status = ANY (ARRAY['submitted'::public.ticket_status, 'needs_review'::public.ticket_status, 'accepted'::public.ticket_status]))))::integer AS tickets_live,
            (count(*) FILTER (WHERE (delivery_tickets.status = ANY (ARRAY['submitted'::public.ticket_status, 'needs_review'::public.ticket_status]))))::integer AS tickets_pending,
            (count(*) FILTER (WHERE (delivery_tickets.status = 'accepted'::public.ticket_status)))::integer AS tickets_accepted,
            md5(string_agg((((delivery_tickets.id)::text || ':'::text) || (delivery_tickets.status)::text), ','::text ORDER BY delivery_tickets.id)) AS documents_fingerprint
           FROM public.delivery_tickets
          WHERE (delivery_tickets.status <> 'superseded'::public.ticket_status)
          GROUP BY delivery_tickets.order_id
        ), exceptions AS (
         SELECT billing_exceptions.order_id,
            (count(*))::integer AS exceptions_count,
            md5(string_agg(billing_exceptions.key, ','::text ORDER BY billing_exceptions.key)) AS exceptions_fingerprint
           FROM public.billing_exceptions
          GROUP BY billing_exceptions.order_id
        ), base AS (
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
           FROM ((((public.orders o
             LEFT JOIN public.customers c ON (((c.id = o.customer_id) AND (c.company_id = o.company_id))))
             LEFT JOIN loads l ON ((l.order_id = o.id)))
             LEFT JOIN tickets t ON ((t.order_id = o.id)))
             LEFT JOIN exceptions e ON ((e.order_id = o.id)))
          WHERE (o.status = ANY (ARRAY['scheduled'::public.order_status, 'dispatched'::public.order_status, 'in_progress'::public.order_status, 'partially_completed'::public.order_status, 'completed'::public.order_status]))
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
           FROM public.billing_reviews x
          WHERE ((x.order_id = b.order_id) AND (x.company_id = b.company_id))) AS last_acknowledged_at,
    h.id AS handoff_order_id,
    h.handoff_id,
    hb.batch_number,
    hb.reference AS handoff_reference,
    hb.created_at AS handed_off_at,
    hb.created_by AS handed_off_by,
    ((h.id IS NOT NULL) AND (h.documents_fingerprint <> b.documents_fingerprint)) AS changed_since_handoff,
        CASE
            WHEN (h.id IS NOT NULL) THEN 'handed_off'::text
            WHEN ((b.loads_missing > 0) OR ((b.status = 'completed'::public.order_status) AND (b.tickets_live = 0))) THEN 'missing_documentation'::text
            WHEN (b.tickets_pending > 0) THEN 'needs_review'::text
            WHEN ((b.exceptions_count > 0) AND (r.id IS NULL)) THEN 'blocked'::text
            WHEN ((b.status <> 'completed'::public.order_status) AND (NOT COALESCE(f.fulfilled, false))) THEN 'in_progress'::text
            ELSE 'ready'::text
        END AS readiness,
    COALESCE(f.fulfilled, false) AS fulfilled,
    f.gap AS fulfillment_gap
   FROM ((((base b
     LEFT JOIN public.order_fulfillment f ON ((f.order_id = b.order_id)))
     LEFT JOIN LATERAL ( SELECT x.id,
            x.company_id,
            x.order_id,
            x.fingerprint,
            x.exceptions,
            x.reason,
            x.decided_by,
            x.decided_at
           FROM public.billing_reviews x
          WHERE ((x.order_id = b.order_id) AND (x.company_id = b.company_id) AND (x.fingerprint = b.exceptions_fingerprint))
          ORDER BY x.decided_at DESC
         LIMIT 1) r ON ((b.exceptions_count > 0)))
     LEFT JOIN public.billing_handoff_orders h ON (((h.order_id = b.order_id) AND (h.company_id = b.company_id) AND (h.reverted_at IS NULL))))
     LEFT JOIN public.billing_handoffs hb ON (((hb.id = h.handoff_id) AND (hb.company_id = h.company_id))));
commit;
