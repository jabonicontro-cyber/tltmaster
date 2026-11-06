-- Rollback of 20261120008500: portal_order as defined in 20261120000700.
create or replace function public.portal_order(p_slug text, p_order uuid)
 returns jsonb
 language plpgsql
 stable
 security definer
 set search_path to ''
as $$
declare
  v public.portal_accounts%rowtype := private.portal_me(p_slug);
begin
  perform private.portal_require_feature(v.company_id, 'orders');
  if not exists (select 1 from public.orders o where o.id = p_order and o.company_id = v.company_id and o.customer_id = v.customer_id and o.status <> 'draft') then
    raise exception 'Order not found.' using errcode = 'P0002';
  end if;
  return private.portal_order_summary(p_order) || jsonb_build_object(
    'instructions', (select o.job_instructions from public.orders o where o.id = p_order),
    'total_cents', (select o.total_cents from public.orders o where o.id = p_order),
    'lines', (select coalesce(jsonb_agg(jsonb_build_object('description', l.description, 'quantity', l.quantity, 'unit', coalesce(nullif(l.unit_label, ''), l.unit_code)) order by l.line_no), '[]'::jsonb)
              from public.order_lines l where l.order_id = p_order),
    'loads', (select coalesce(jsonb_agg(jsonb_build_object('number', ld.load_number, 'date', ld.load_date, 'start', ld.start_time, 'end', ld.end_time,
                                                            'quantity', ld.planned_quantity, 'unit', private.portal_unit(ld.company_id, ld.unit_code), 'canceled', ld.status = 'canceled')
                                        order by ld.load_date, ld.start_time nulls last, ld.load_number), '[]'::jsonb)
              from public.order_loads ld where ld.order_id = p_order),
    'tickets', case when private.portal_feature(v.company_id, 'documents') then
              (select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'number', t.ticket_number, 'delivered_at', t.delivered_at, 'quantity', t.quantity, 'unit', private.portal_unit(t.company_id, t.unit_code),
                                                             'confirmed', t.status = 'accepted') order by t.delivered_at), '[]'::jsonb)
               from public.delivery_tickets t where t.order_id = p_order and t.status in ('submitted', 'needs_review', 'accepted'))
              else '[]'::jsonb end,
    'history', (select coalesce(jsonb_agg(jsonb_build_object('label', private.portal_order_label(e.to_status), 'at', e.occurred_at) order by e.occurred_at), '[]'::jsonb)
                from public.order_status_events e where e.order_id = p_order and e.to_status <> 'draft'));
end;
$$;
