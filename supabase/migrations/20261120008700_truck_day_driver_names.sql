-- Trucks for the day, follow-up (UX11, owner 2026-11-06: "add as order line"):
-- 1. The truck-hours card named no driver when the driver's name lives on their sign-in profile (drivers.name empty);
--    same rule as delivery tickets now: the profile's full name, else the driver record's name.
-- 2. Billing adds the reviewed truck-hours to the order as one hourly line ("Add to order"), like detention: a person
--    approves it; only trucks with counted hours that were not billed yet; each truck is marked with its line so it is
--    never billed twice. The line is billed without a delivery ticket (its charge item is not ticket_required).
-- Reversible: supabase/rollbacks/20261120008700_truck_day_driver_names.down.sql.

alter table public.order_loads add column truck_hours_line_id uuid references public.order_lines (id) on delete set null;

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
      join public.charge_items ci on ci.id = e.charge_item_id and ci.company_id = v_company and ci.kind = 'hauling' and ci.active
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
        'billed', l.truck_hours_line_id is not null,
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

create or replace function public.truck_hours_apply(p_order uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid;
  v_order   public.orders%rowtype;
  v_hours   jsonb;
  v_rate    bigint;
  v_total   numeric := 0;
  v_ids     uuid[] := '{}';
  v_parts   text[] := '{}';
  v_days    text[] := '{}';
  v_item    uuid;
  v_line    uuid;
  v_no      integer;
  v_amount  bigint;
  t         jsonb;
begin
  perform private.require_permission('billing.manage');
  v_company := private.require_company();
  select * into v_order from public.orders where id = p_order and company_id = v_company for update;
  if not found then raise exception 'Order not found.' using errcode = 'P0002'; end if;
  if v_order.job_type <> 'truck_day' or v_order.truck_billing <> 'hours' then
    raise exception 'Order % is not billed by truck-hours.', v_order.order_number using errcode = '22023';
  end if;
  if v_order.status in ('draft', 'canceled') then raise exception 'Truck-hours are added to scheduled or completed orders only.' using errcode = '22023'; end if;
  if exists (select 1 from public.billing_order_status s where s.order_id = v_order.id and s.company_id = v_company and s.readiness = 'handed_off') then
    raise exception 'This order was already handed off for billing. Undo the handoff first.' using errcode = '22023';
  end if;
  if not exists (select 1 from public.units_of_measure where company_id = v_company and code = 'hour') then
    raise exception 'Add the unit "hour" (Rates and pricing, Units) before adding truck-hours.' using errcode = '22023';
  end if;
  v_hours := public.truck_day_hours(p_order);
  v_rate := nullif(v_hours ->> 'rate_cents', '')::bigint;
  if v_rate is null then
    raise exception 'No hourly rate: add an hourly line to the order or an hourly hauling rate to the customer''s price list.' using errcode = '22023';
  end if;
  for t in select * from jsonb_array_elements(v_hours -> 'trucks') loop
    if (t ->> 'billable') is not null and not coalesce((t ->> 'billed')::boolean, false) then
      v_total := v_total + (t ->> 'billable')::numeric;
      v_ids := v_ids || (t ->> 'load_id')::uuid;
      v_parts := v_parts || format('%s %s h', t ->> 'truck', trim(to_char((t ->> 'billable')::numeric, 'FM9990.00')));
      if not (to_char((t ->> 'date')::date, 'Mon FMDD') = any (v_days)) then v_days := v_days || to_char((t ->> 'date')::date, 'Mon FMDD'); end if;
    end if;
  end loop;
  if v_total <= 0 then
    raise exception 'No truck-hours to add: none are counted yet (trucks not released, arrival missing, or hours off), or they were already added.' using errcode = '22023';
  end if;
  v_total := round(v_total, 2);
  v_amount := round(v_total * v_rate);

  -- The company's truck-hours charge: its own (code TRUCK-HOURS), else one is created, billed without a ticket.
  select id into v_item from public.charge_items where company_id = v_company and active and upper(code) = 'TRUCK-HOURS' limit 1;
  if v_item is null then
    insert into public.charge_items (company_id, code, name, description, kind, calc_method, default_unit_code, ticket_required)
    values (v_company, 'TRUCK-HOURS', 'Truck hours (per hour)', 'Trucks for the day, billed by the hours each truck worked until released.',
            'hauling', 'per_unit', 'hour', false)
    on conflict do nothing
    returning id into v_item;
    if v_item is null then select id into v_item from public.charge_items where company_id = v_company and upper(code) = 'TRUCK-HOURS' limit 1; end if;
  end if;

  perform set_config('tlt.billed_extra', 'on', true);
  select coalesce(max(line_no), 0) + 1 into v_no from public.order_lines where order_id = v_order.id;
  insert into public.order_lines (company_id, order_id, line_no, kind, calc_method, charge_item_id, description, unit_code,
                                  unit_label, quantity, unit_rate_cents, price_source, taxable, amount_cents)
  values (v_company, v_order.id, v_no, 'hauling', 'per_unit', v_item,
          left(format('Truck hours: %s (%s)', array_to_string(v_days, ', '), array_to_string(v_parts, ', ')), 300),
          'hour', 'hours', v_total, v_rate, 'manual', false, v_amount)
  returning id into v_line;
  perform private.recompute_order_totals(v_order.id);
  update public.orders set edit_seq = edit_seq + 1 where id = v_order.id;
  perform set_config('tlt.billed_extra', 'off', true);

  update public.order_loads set truck_hours_line_id = v_line where id = any (v_ids) and company_id = v_company;
  perform private.log_event('billing.truck_hours_added', 'order', v_order.id,
    format('Truck hours added: %s h at %s per hour (%s)', v_total, to_char(v_rate / 100.0, 'FM999999990.00'), array_to_string(v_parts, ', ')),
    jsonb_build_object('order_line_id', v_line, 'hours', v_total, 'amount_cents', v_amount, 'load_ids', to_jsonb(v_ids)));
  return jsonb_build_object('line_id', v_line, 'hours', v_total, 'amount_cents', v_amount, 'trucks', cardinality(v_ids));
end;
$$;
revoke all on function public.truck_hours_apply(uuid) from public, anon;
grant execute on function public.truck_hours_apply(uuid) to authenticated;
