-- =============================================================================
-- N14 (part 2): measured operations report.
--
-- One read-only function that summarizes a period from records that already
-- exist. It runs as the caller (SECURITY INVOKER): row-level security limits
-- every row to the caller's company, and each section is returned only with
-- the permission that already grants its underlying data:
--   deliveries & rework  tickets.view or billing.view
--   verified value, billing turnaround, revenue waiting  billing.view
--   truck utilization & downtime  fleet.view or dispatch.view
-- Current ticket revisions are counted by their delivery date in the
-- company's time zone. Nothing is estimated. Values are "verified delivered value": accepted
-- current ticket quantities × the order line's approved rate, in the line's
-- unit, before percentage charges, discounts and tax. Tickets that cannot be
-- priced that way are counted, not guessed. Profitability is not computed:
-- there is no cost data (fuel, wages, maintenance, material cost).
-- =============================================================================

create or replace function public.report_operations(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_company uuid := private.current_company_id();
  v_tz      text;
  v_out     jsonb;
  v_days    integer;
begin
  if v_company is null then
    raise exception 'No company.' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then
    raise exception 'Choose a period of up to one year.' using errcode = '22023';
  end if;
  select coalesce(nullif(s.timezone, ''), 'America/Chicago') into v_tz from public.company_settings s where s.company_id = v_company;
  v_tz := coalesce(v_tz, 'America/Chicago');
  v_days := p_to - p_from + 1;
  v_out := jsonb_build_object('from', p_from, 'to', p_to, 'days', v_days, 'as_of', now());

  if private.has_permission('tickets.view') or private.has_permission('billing.view') then
    v_out := v_out || jsonb_build_object('deliveries', (
      select jsonb_build_object(
        'tickets', count(*),
        'accepted', count(*) filter (where status = 'accepted'),
        'pending', count(*) filter (where status in ('submitted', 'needs_review')),
        'voided', count(*) filter (where status = 'voided'),
        'corrected', count(*) filter (where revision > 1),
        'median_hours_to_accept', round((percentile_cont(0.5) within group (order by extract(epoch from (reviewed_at - delivered_at)) / 3600)
                                         filter (where status = 'accepted' and reviewed_at is not null))::numeric, 1))
      from (select t.id, t.status::text as status, t.revision, t.quantity, t.unit_code, t.order_id, t.order_line_id, t.truck_id, t.delivered_at, t.reviewed_at
           from public.delivery_tickets t
           where t.company_id = v_company and t.status <> 'superseded'
             and (t.delivered_at at time zone v_tz)::date between p_from and p_to) rt));
  end if;

  if private.has_permission('billing.view') then
    with priced as (
      select t.*, l.unit_rate_cents, l.calc_method, l.unit_code as line_unit, l.description as line_description,
             o.customer_id, (t.unit_code = l.unit_code and l.calc_method = 'per_unit' and l.unit_rate_cents > 0) as can_price
      from (select t.id, t.status::text as status, t.revision, t.quantity, t.unit_code, t.order_id, t.order_line_id, t.truck_id, t.delivered_at, t.reviewed_at
           from public.delivery_tickets t
           where t.company_id = v_company and t.status <> 'superseded'
             and (t.delivered_at at time zone v_tz)::date between p_from and p_to) t
      left join public.order_lines l on l.id = t.order_line_id and l.company_id = v_company
      left join public.orders o on o.id = t.order_id and o.company_id = v_company
      where t.status = 'accepted'
    ), valued as (
      select *, case when can_price then round(quantity * unit_rate_cents)::bigint end as value_cents from priced
    )
    select v_out || jsonb_build_object('value', jsonb_build_object(
      'verified_value_cents', coalesce(sum(value_cents), 0),
      'priced_tickets', count(*) filter (where can_price),
      'unpriced_tickets', count(*) filter (where not coalesce(can_price, false)),
      'by_customer', coalesce((select jsonb_agg(x order by x.value_cents desc) from (
          select c.name, count(*) as tickets, sum(v.value_cents) as value_cents
          from valued v left join public.customers c on c.id = v.customer_id and c.company_id = v_company
          where v.can_price group by c.name order by sum(v.value_cents) desc limit 10) x), '[]'),
      'by_line', coalesce((select jsonb_agg(x order by x.value_cents desc) from (
          select v.line_description as name, v.line_unit as unit, sum(v.quantity) as quantity, count(*) as tickets, sum(v.value_cents) as value_cents
          from valued v where v.can_price group by v.line_description, v.line_unit order by sum(v.value_cents) desc limit 10) x), '[]'),
      'by_truck', coalesce((select jsonb_agg(x order by x.value_cents desc) from (
          select tr.unit_number as name, count(*) as tickets, sum(v.value_cents) as value_cents
          from valued v left join public.trucks tr on tr.id = v.truck_id and tr.company_id = v_company
          where v.can_price group by tr.unit_number order by sum(v.value_cents) desc limit 10) x), '[]')))
    into v_out
    from valued;

    -- Billing turnaround: orders handed off in the period, from their last
    -- accepted delivery to the handoff.
    v_out := v_out || jsonb_build_object('billing', (
      select jsonb_build_object(
        'handed_off_orders', count(*),
        'median_days_delivery_to_handoff', round((percentile_cont(0.5) within group (order by extract(epoch from (h.created_at - d.last_delivery)) / 86400))::numeric, 1)
      )
      from public.billing_handoff_orders ho
      join public.billing_handoffs h on h.id = ho.handoff_id and h.company_id = v_company
      cross join lateral (select max(t.delivered_at) as last_delivery from public.delivery_tickets t
                          where t.order_id = ho.order_id and t.company_id = v_company and t.status = 'accepted') d
      where ho.company_id = v_company and ho.reverted_at is null and d.last_delivery is not null
        and (h.created_at at time zone v_tz)::date between p_from and p_to)
      || (select jsonb_build_object(
            'ready_not_handed_off', count(*) filter (where readiness = 'ready'),
            'ready_ordered_total_cents', coalesce(sum(total_cents) filter (where readiness = 'ready'), 0),
            'loads_missing_tickets', coalesce(sum(loads_missing), 0),
            'orders_with_missing_tickets', count(*) filter (where loads_missing > 0))
          from public.billing_order_status where company_id = v_company));
  end if;

  if private.has_permission('fleet.view') or private.has_permission('dispatch.view') then
    v_out := v_out || jsonb_build_object('fleet', coalesce((
      select jsonb_agg(x order by x.loads desc, x.unit_number) from (
        select tr.unit_number,
               (select count(*) from public.dispatch_assignments a join public.order_loads l on l.id = a.load_id and l.company_id = a.company_id
                 where a.truck_id = tr.id and a.company_id = v_company and a.status = 'active' and l.status = 'planned'
                   and l.load_date between p_from and p_to) as loads,
               (select count(distinct l.load_date) from public.dispatch_assignments a join public.order_loads l on l.id = a.load_id and l.company_id = a.company_id
                 where a.truck_id = tr.id and a.company_id = v_company and a.status = 'active' and l.status = 'planned'
                   and l.load_date between p_from and p_to) as days_with_loads,
               -- Days out of service within the period, from the status history.
               (select coalesce(sum(greatest(0, least(coalesce(e.until_date, p_to), p_to) - greatest(e.from_date, p_from) + 1)), 0)
                from (select (ev.occurred_at at time zone v_tz)::date as from_date, ev.to_status,
                             (lead(ev.occurred_at) over (order by ev.occurred_at) at time zone v_tz)::date - 1 as until_date
                      from public.equipment_status_events ev
                      where ev.truck_id = tr.id and ev.company_id = v_company) e
                where e.to_status = 'out_of_service' and e.from_date <= p_to and coalesce(e.until_date, p_to) >= p_from) as days_out_of_service
        from public.trucks tr
        where tr.company_id = v_company and tr.active) x), '[]'));
  end if;

  return v_out || jsonb_build_object('profitability', jsonb_build_object(
    'available', false,
    'missing', jsonb_build_array('fuel cost', 'driver wages or pay rules', 'maintenance and repair cost', 'material purchase cost', 'equipment ownership cost')));
end;
$$;

revoke execute on function public.report_operations(date, date) from public, anon;
grant execute on function public.report_operations(date, date) to authenticated;
