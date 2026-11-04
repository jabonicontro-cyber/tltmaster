-- Rollback of 20261120006500_billing_tolerance: the exceptions view returns to an exact match, then the setting goes.
create or replace view public.billing_exceptions with (security_invoker = true) as
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
           FROM billing_load_status
          WHERE billing_load_status.quantity_check = ANY (ARRAY['over'::text, 'under'::text, 'units_differ'::text])) l
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
            WHEN x.exception_kind = 'line_quantity'::text THEN x.quantity_difference
            ELSE NULL::numeric
        END AS difference,
    concat_ws(':'::text, 'line', x.line_id, x.exception_kind, x.ordered_quantity, x.unit_code, x.delivered_quantity, x.unit_rate_cents, array_to_string(x.ticket_units, '|'::text)) AS key
   FROM ( SELECT b.line_id,
            b.company_id,
            b.order_id,
            b.order_status,
            b.line_no,
            b.kind,
            b.description,
            b.material_id,
            b.unit_code,
            b.ordered_quantity,
            b.unit_rate_cents,
            b.amount_cents,
            b.price_source,
            b.live_count,
            b.pending_count,
            b.other_unit_count,
            b.delivered_quantity,
            b.ticket_units,
            b.quantity_check,
            b.quantity_difference,
            b.pricing_check,
            k.exception_kind
           FROM billing_line_status b
             CROSS JOIN LATERAL ( VALUES (
                        CASE
                            WHEN b.quantity_check = ANY (ARRAY['over'::text, 'under'::text]) THEN 'line_quantity'::text
                            WHEN b.quantity_check = 'units_differ'::text THEN 'line_units_differ'::text
                            WHEN b.quantity_check = 'no_tickets'::text THEN 'line_no_tickets'::text
                            ELSE NULL::text
                        END), (
                        CASE
                            WHEN b.pricing_check = 'zero_rate'::text THEN 'line_zero_rate'::text
                            ELSE NULL::text
                        END)) k(exception_kind)
          WHERE k.exception_kind IS NOT NULL) x
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
   FROM orders o
     JOIN customers c ON c.id = o.customer_id AND c.company_id = o.company_id
  WHERE c.po_required AND TRIM(BOTH FROM o.customer_po) = ''::text AND (o.status = ANY (ARRAY['scheduled'::order_status, 'dispatched'::order_status, 'in_progress'::order_status, 'partially_completed'::order_status, 'completed'::order_status]));

drop function if exists public.billing_save_tolerance(numeric);
drop table if exists public.billing_tolerance_settings;
