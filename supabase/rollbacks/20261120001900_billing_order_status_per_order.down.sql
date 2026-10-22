-- Rollback of 20261120001900_billing_order_status_per_order.sql. Not destructive: restores the earlier definition of
-- public.billing_order_status (company-wide grouped aggregates; same columns and rows). Run with psql -v ON_ERROR_STOP=1 -1 -f.

create or replace view public.billing_order_status with (security_invoker = true) as
WITH loads AS (
         SELECT billing_load_status.company_id,
            billing_load_status.order_id,
            count(*)::integer AS loads_total,
            count(*) FILTER (WHERE billing_load_status.is_due)::integer AS loads_due,
            count(*) FILTER (WHERE billing_load_status.documentation_state = 'missing'::text)::integer AS loads_missing,
            count(*) FILTER (WHERE billing_load_status.documentation_state = 'not_due'::text)::integer AS loads_not_due,
            min(billing_load_status.load_date) AS first_load_date,
            max(billing_load_status.load_date) AS last_load_date
           FROM billing_load_status
          GROUP BY billing_load_status.company_id, billing_load_status.order_id
        ), tickets AS (
         SELECT delivery_tickets.company_id,
            delivery_tickets.order_id,
            count(*) FILTER (WHERE delivery_tickets.status = ANY (ARRAY['submitted'::ticket_status, 'needs_review'::ticket_status, 'accepted'::ticket_status]))::integer AS tickets_live,
            count(*) FILTER (WHERE delivery_tickets.status = ANY (ARRAY['submitted'::ticket_status, 'needs_review'::ticket_status]))::integer AS tickets_pending,
            count(*) FILTER (WHERE delivery_tickets.status = 'accepted'::ticket_status)::integer AS tickets_accepted,
            md5(string_agg((delivery_tickets.id::text || ':'::text) || delivery_tickets.status::text, ','::text ORDER BY delivery_tickets.id)) AS documents_fingerprint
           FROM delivery_tickets
          WHERE delivery_tickets.status <> 'superseded'::ticket_status
          GROUP BY delivery_tickets.company_id, delivery_tickets.order_id
        ), exceptions AS (
         SELECT billing_exceptions.company_id,
            billing_exceptions.order_id,
            count(*)::integer AS exceptions_count,
            md5(string_agg(billing_exceptions.key, ','::text ORDER BY billing_exceptions.key)) AS exceptions_fingerprint
           FROM billing_exceptions
          GROUP BY billing_exceptions.company_id, billing_exceptions.order_id
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
           FROM orders o
             LEFT JOIN customers c ON c.id = o.customer_id AND c.company_id = o.company_id
             LEFT JOIN loads l ON l.order_id = o.id AND l.company_id = o.company_id
             LEFT JOIN tickets t ON t.order_id = o.id AND t.company_id = o.company_id
             LEFT JOIN exceptions e ON e.order_id = o.id AND e.company_id = o.company_id
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
