-- Pickup on the order (UX7, owner 2026-11-04): drivers saw where to deliver but never where to load. An order may name
-- one of the company's own locations (quarry, plant, pickup, terminal, yard) as its pickup; the driver's load card shows
-- it with a way to navigate there. Optional and additive: orders without one behave as before.
-- Reversible: supabase/rollbacks/20261120006600_order_pickup.down.sql.

alter table public.orders add column pickup_location_id uuid;
alter table public.orders add constraint orders_pickup_location_fkey
  foreign key (company_id, pickup_location_id) references public.company_locations (company_id, id) on delete set null (pickup_location_id);
create index orders_pickup_location_idx on public.orders (company_id, pickup_location_id) where pickup_location_id is not null;

-- Set or clear an order's pickup. Orders editors only; the location must be an active location of the same company.
create or replace function public.set_order_pickup(p_order uuid, p_location uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v_number  text;
  v_name    text;
begin
  perform private.require_permission('orders.edit');
  if p_location is not null then
    select name into v_name from public.company_locations where id = p_location and company_id = v_company and active;
    if v_name is null then
      raise exception 'Choose one of your active locations.' using errcode = 'P0002';
    end if;
  end if;
  update public.orders set pickup_location_id = p_location where id = p_order and company_id = v_company returning order_number into v_number;
  if v_number is null then
    raise exception 'Order not found.' using errcode = 'P0002';
  end if;
  perform private.log_event('order.pickup_set', 'order', p_order,
    case when p_location is null then format('Pickup cleared on %s', v_number) else format('Pickup for %s: %s', v_number, v_name) end,
    jsonb_build_object('location_id', p_location));
end;
$$;
revoke all on function public.set_order_pickup(uuid, uuid) from public, anon;
grant execute on function public.set_order_pickup(uuid, uuid) to authenticated;

-- The pickups of the signed-in driver's own loads (two days back to tomorrow), keyed by load. Name, address and point
-- only; nothing about other drivers or other loads.
create or replace function public.driver_load_pickups()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_d     public.drivers%rowtype := private.portal_driver();
  v_today date := private.business_today(v_d.company_id);
begin
  return coalesce((
    select jsonb_object_agg(l.id, jsonb_build_object(
             'name', cl.name, 'kind', cl.kind,
             'address', concat_ws(', ', nullif(cl.address_line1, ''), nullif(cl.city, ''), nullif(cl.state, '')),
             'latitude', cl.latitude, 'longitude', cl.longitude))
    from public.dispatch_assignments a
    join public.order_loads l on l.id = a.load_id and l.company_id = a.company_id
    join public.orders o on o.id = l.order_id and o.company_id = l.company_id
    join public.company_locations cl on cl.id = o.pickup_location_id and cl.company_id = o.company_id
    where a.company_id = v_d.company_id and a.driver_id = v_d.id and a.status = 'active'
      and l.load_date between v_today - 2 and v_today + 1), '{}'::jsonb);
end;
$$;
revoke all on function public.driver_load_pickups() from public, anon;
grant execute on function public.driver_load_pickups() to authenticated;
