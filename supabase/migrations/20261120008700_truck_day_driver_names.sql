-- Truck-hours card (UX11): a driver whose name lives on their sign-in profile (drivers.name empty) showed no name.
-- Same rule as delivery tickets: the profile's full name, else the driver record's name. Only public.truck_day_hours
-- changes; the rollback restores the 20261120008600 definition.
create or replace function public.truck_day_hours(p_order uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v_order public.orders%rowtype;
  s public.truck_hours_settings%rowtype;
  v_rate bigint;
  v_rate_source text;
begin
  perform private.require_permission('billing.view');
  select * into v_order from public.orders where id = p_order and company_id = v_company;
  if not found then raise exception 'Order not found.' using errcode = 'P0002'; end if;
  select * into s from public.truck_hours_settings where company_id = v_company;
  -- The order's own hourly line first, then the customer's standing hourly rate (hauling by the hour).
  select l.unit_rate_cents into v_rate from public.order_lines l
   where l.order_id = p_order and l.company_id = v_company and l.unit_code = 'hour' and l.calc_method = 'per_unit' and l.kind <> 'discount'
   order by l.line_no limit 1;
  if v_rate is not null then
    v_rate_source := 'order';
  else
    select e.rate_cents, case when pl.is_standard then 'standard' else 'customer' end into v_rate, v_rate_source
      from public.price_list_entries e
      join public.price_lists pl on pl.id = e.price_list_id and pl.company_id = v_company and pl.active
      join public.charge_items ci on ci.id = e.charge_item_id and ci.company_id = v_company and ci.kind = 'hauling'
      left join public.customers c on c.id = v_order.customer_id and c.company_id = v_company
     where e.unit_code = 'hour' and e.rate_cents is not null
       and (pl.id = c.price_list_id or pl.is_standard)
       and e.effective_from <= coalesce(v_order.scheduled_start, current_date) and (e.effective_to is null or e.effective_to >= coalesce(v_order.scheduled_start, current_date))
     order by (pl.id = c.price_list_id) desc, e.effective_from desc
     limit 1;
  end if;
  return jsonb_build_object(
    'job_type', v_order.job_type, 'billing', v_order.truck_billing,
    'basis', s.basis, 'minimum_hours', s.minimum_hours, 'shortfall', coalesce(s.shortfall, 'review'),
    'rate_cents', v_rate, 'rate_source', v_rate_source,
    'trucks', (select coalesce(jsonb_agg(r order by r ->> 'date', r ->> 'start', r ->> 'truck'), '[]'::jsonb) from (
      select jsonb_build_object(
        'load_id', l.id, 'load_number', l.load_number, 'date', l.load_date, 'truck', t.unit_number,
        'driver', coalesce(nullif(btrim(p.full_name), ''), nullif(d.name, ''), ''), 'start', st.start_at, 'released_at', l.released_at, 'release_source', l.release_source,
        'trips', (select count(*) from public.delivery_tickets dt where dt.load_id = l.id and dt.status in ('submitted', 'needs_review', 'accepted')),
        'hours', h.hours,
        'billable', case when h.hours is null then null
                         when s.minimum_hours is not null and h.hours < s.minimum_hours and s.shortfall = 'bill_minimum' then s.minimum_hours
                         else h.hours end,
        'short', h.hours is not null and s.minimum_hours is not null and h.hours < s.minimum_hours,
        'missing', case when s.basis is null then 'off'
                        when l.released_at is null then 'not_released'
                        when st.start_at is null then 'no_arrival'
                        else null end) as r
      from public.order_loads l
      join public.dispatch_assignments a on a.load_id = l.id and a.company_id = l.company_id
           and a.id = (select a2.id from public.dispatch_assignments a2 where a2.load_id = l.id order by (a2.status = 'active') desc, a2.created_at desc limit 1)
      join public.trucks t on t.id = a.truck_id
      left join public.drivers d on d.id = a.driver_id
      left join public.profiles p on p.id = d.user_id
      cross join lateral (select case s.basis
                                   when 'scheduled' then l.starts_at
                                   when 'arrived' then (select min(x.arrived_at) from public.load_stop_times x where x.load_id = l.id and x.company_id = l.company_id)
                                 end as start_at) st
      cross join lateral (select case when s.basis is not null and l.released_at is not null and st.start_at is not null and l.released_at > st.start_at
                                      then round(extract(epoch from (l.released_at - st.start_at)) / 3600.0, 2) end as hours) h
      where l.order_id = p_order and l.company_id = v_company and l.status = 'planned'
        and (a.status = 'active' or l.released_at is not null)
    ) q));
end;
$$;
revoke all on function public.truck_day_hours(uuid) from public, anon;
grant execute on function public.truck_day_hours(uuid) to authenticated;
