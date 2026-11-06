-- UX5 (portal): each ordered line shows how much has been delivered and how much is left, counted like billing does
-- (live tickets for the line in the line's unit: submitted, being checked or confirmed). Lines billed without a delivery
-- ticket (lumper, detention, flat charges, discounts) are not tracked. Only public.portal_order changes; the rollback
-- restores the 20261120000700 definition.
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
    'lines', (select coalesce(jsonb_agg(jsonb_build_object('description', l.description, 'quantity', l.quantity, 'unit', coalesce(nullif(l.unit_label, ''), l.unit_code),
                                                            'tracked', d.tracked, 'delivered', d.delivered, 'confirmed', d.confirmed,
                                                            'remaining', case when d.tracked and l.quantity is not null then greatest(l.quantity - coalesce(d.delivered, 0), 0) end)
                                        order by l.line_no), '[]'::jsonb)
              from public.order_lines l
              cross join lateral (
                select (l.calc_method = 'per_unit' and l.kind <> 'discount'
                        and not exists (select 1 from public.charge_items ci where ci.id = l.charge_item_id and ci.company_id = l.company_id and not ci.ticket_required)) as tracked,
                       sum(t.quantity) filter (where t.unit_code = l.unit_code) as delivered,
                       sum(t.quantity) filter (where t.unit_code = l.unit_code and t.status = 'accepted') as confirmed
                from public.delivery_tickets t
                where t.order_line_id = l.id and t.company_id = l.company_id and t.status in ('submitted', 'needs_review', 'accepted')) d
              where l.order_id = p_order),
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
