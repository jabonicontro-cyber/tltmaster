-- Truck-day jobs (UX11, specified by the owner 2026-11-04): besides "a set number of loads", an order can run as
-- "N trucks for the day from 6:30", with loads counted from tickets. Built on the existing records, never a parallel
-- dispatch system:
--   * each truck for the day is one order_loads row without a planned quantity (a "slot"), assigned with assign_load
--     like any load, so overlap, eligibility, hours-of-service and the board all apply unchanged;
--   * the driver enters a delivery ticket per trip against that slot (tickets already allow several per load);
--   * a truck is released by dispatch, by its own driver (My Day) or by the customer's site contact (portal). Release
--     records who and when, and ends the assignment at that moment so the truck and driver can take a later job the
--     same day (the existing overlap rules still forbid two jobs at once).
-- Billing per order: by ticket quantity (as today) or by truck-hours. Which hours count is a company setting, off until
-- set (scheduled start or recorded arrival, until release), with an optional minimum per truck and what to do with a
-- shortfall (bill the minimum or flag for review). The hourly rate is the order's hourly line, else the customer's
-- standing hourly rate (customer price list, then standard list). Hours are a computed preview for billing review;
-- nothing is added to an order or an invoice here.
-- Reversible: supabase/rollbacks/20261120008600_truck_day_jobs.down.sql.

alter table public.orders
  add column job_type text not null default 'loads' check (job_type in ('loads', 'truck_day')),
  add column truck_billing text not null default 'tickets' check (truck_billing in ('tickets', 'hours'));
comment on column public.orders.job_type is 'loads = a set number of loads (default); truck_day = trucks for the day, loads counted from tickets (UX11).';
comment on column public.orders.truck_billing is 'Truck-day orders: tickets = by ticket quantity; hours = by truck-hours (company setting decides which hours).';

alter table public.order_loads
  add column released_at timestamptz,
  add column released_by uuid references auth.users (id) on delete set null,
  add column release_source text check (release_source in ('dispatch', 'driver', 'site')),
  add column release_note text not null default '' check (length(release_note) <= 300),
  add constraint order_loads_release_pair check ((released_at is null) = (release_source is null));

create table public.truck_hours_settings (
  company_id    uuid primary key references public.companies (id) on delete cascade,
  -- Which hours count; null = off (no truck-hours are computed).
  basis         text check (basis in ('scheduled', 'arrived')),
  -- Optional minimum billable hours per truck per day.
  minimum_hours numeric(4,2) check (minimum_hours is null or (minimum_hours > 0 and minimum_hours <= 24)),
  -- A truck that worked less than the minimum: bill the minimum, or flag it for review.
  shortfall     text not null default 'review' check (shortfall in ('bill_minimum', 'review')),
  updated_by    uuid references auth.users (id) on delete set null,
  updated_at    timestamptz not null default now()
);
alter table public.truck_hours_settings enable row level security;
create policy truck_hours_settings_read on public.truck_hours_settings for select to authenticated
  using (company_id = (select private.current_company_id()));
revoke all on public.truck_hours_settings from anon;
grant select on public.truck_hours_settings to authenticated;

-- How the order runs (orders.edit). Changing to or from truck-day is refused once the order has live tickets, so a
-- job's billing basis never changes under delivered work.
create or replace function public.set_order_job_type(p_order uuid, p_job_type text, p_billing text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v_order public.orders%rowtype;
begin
  perform private.require_permission('orders.edit');
  if p_job_type not in ('loads', 'truck_day') then raise exception 'Choose loads or trucks for the day.' using errcode = '22023'; end if;
  if p_billing not in ('tickets', 'hours') then raise exception 'Choose billing by tickets or by truck-hours.' using errcode = '22023'; end if;
  if p_job_type = 'loads' and p_billing = 'hours' then raise exception 'Billing by truck-hours applies to trucks for the day.' using errcode = '22023'; end if;
  select * into v_order from public.orders where id = p_order and company_id = v_company for update;
  if not found then raise exception 'Order not found.' using errcode = 'P0002'; end if;
  if v_order.status in ('completed', 'canceled') then raise exception 'Order % is %; its job type no longer changes.', v_order.order_number, v_order.status using errcode = '22023'; end if;
  if (v_order.job_type, v_order.truck_billing) = (p_job_type, p_billing) then return; end if;
  if v_order.job_type <> p_job_type and exists (
    select 1 from public.delivery_tickets t where t.order_id = p_order and t.company_id = v_company and t.status in ('submitted', 'needs_review', 'accepted')
  ) then
    raise exception 'Order % already has delivery tickets; its job type cannot change.', v_order.order_number using errcode = '22023';
  end if;
  update public.orders set job_type = p_job_type, truck_billing = p_billing where id = p_order;
  perform private.log_event('order.job_type_set', 'order', p_order,
    format('%s runs as %s, billed by %s', v_order.order_number,
           case p_job_type when 'truck_day' then 'trucks for the day' else 'a set number of loads' end,
           case p_billing when 'hours' then 'truck-hours' else 'ticket quantity' end),
    jsonb_build_object('job_type', p_job_type, 'truck_billing', p_billing));
end;
$$;
revoke all on function public.set_order_job_type(uuid, text, text) from public, anon;
grant execute on function public.set_order_job_type(uuid, text, text) to authenticated;

-- N trucks for one day (dispatch.edit): N slots through save_order_load (its own checks: dispatchable order, date
-- within the order's schedule, times). Returns the new load ids.
create or replace function public.truck_day_plan(p_order uuid, p_date date, p_trucks integer, p_start time, p_end time, p_note text default '')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v_order public.orders%rowtype;
  v_ids jsonb := '[]'::jsonb;
  v_r jsonb;
begin
  perform private.require_permission('dispatch.edit');
  select * into v_order from public.orders where id = p_order and company_id = v_company;
  if not found then raise exception 'Order not found.' using errcode = 'P0002'; end if;
  if v_order.job_type <> 'truck_day' then raise exception 'Order % runs as a set number of loads. Set it to trucks for the day first.', v_order.order_number using errcode = '22023'; end if;
  if p_trucks is null or p_trucks < 1 or p_trucks > 50 then raise exception 'Choose 1 to 50 trucks.' using errcode = '22023'; end if;
  for i in 1..p_trucks loop
    v_r := public.save_order_load(jsonb_build_object('order_id', p_order, 'load_date', p_date, 'start_time', p_start, 'end_time', p_end,
                                                     'notes', coalesce(p_note, '')));
    v_ids := v_ids || jsonb_build_array(v_r ->> 'load_id');
  end loop;
  return jsonb_build_object('load_ids', v_ids, 'count', p_trucks);
end;
$$;
revoke all on function public.truck_day_plan(uuid, date, integer, time, time, text) from public, anon;
grant execute on function public.truck_day_plan(uuid, date, integer, time, time, text) to authenticated;

-- Release one truck. Shared core: the slot must be a truck-day slot, planned, assigned and started, not released yet.
-- The assignment ends now (never before it started), freeing the truck and driver for a later job that day.
create or replace function private.truck_day_release_core(p_company uuid, p_load uuid, p_source text, p_note text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_load public.order_loads%rowtype;
  v_order public.orders%rowtype;
  v_asg public.dispatch_assignments%rowtype;
  v_now timestamptz := now();
begin
  select * into v_load from public.order_loads where id = p_load and company_id = p_company for update;
  if not found then raise exception 'Truck not found.' using errcode = 'P0002'; end if;
  select * into v_order from public.orders where id = v_load.order_id;
  if v_order.job_type <> 'truck_day' then raise exception 'Only trucks for the day are released.' using errcode = '22023'; end if;
  if v_load.status <> 'planned' then raise exception 'This truck''s slot is canceled.' using errcode = '22023'; end if;
  if v_load.released_at is not null then raise exception 'This truck was already released at %.', private.local_time_label(p_company, v_load.released_at) using errcode = '22023'; end if;
  select * into v_asg from public.dispatch_assignments where load_id = p_load and status = 'active' for update;
  if not found then raise exception 'No truck is assigned to this slot yet.' using errcode = '22023'; end if;
  if v_now <= v_asg.starts_at then raise exception 'This truck has not started yet (starts at %).', private.local_time_label(p_company, v_asg.starts_at) using errcode = '22023'; end if;
  update public.order_loads set released_at = v_now, released_by = auth.uid(), release_source = p_source,
         release_note = private.clean_text(coalesce(p_note, ''), 300, 'Note'), updated_at = v_now
   where id = p_load;
  if v_now < v_asg.ends_at then
    update public.dispatch_assignments set ends_at = v_now where id = v_asg.id;
  end if;
  perform private.log_event('dispatch.truck_released', 'order', v_order.id,
    format('%s load %s released by %s at %s', v_order.order_number, v_load.load_number,
           case p_source when 'driver' then 'the driver' when 'site' then 'the customer''s site contact' else 'dispatch' end,
           private.local_time_label(p_company, v_now)),
    jsonb_build_object('load_id', p_load, 'source', p_source));
  return jsonb_build_object('released_at', v_now, 'load_number', v_load.load_number, 'order_number', v_order.order_number);
end;
$$;
revoke all on function private.truck_day_release_core(uuid, uuid, text, text) from public, anon, authenticated;

-- Dispatch (dispatch.edit) or the slot's own driver.
create or replace function public.truck_day_release(p_load uuid, p_note text default '')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v_driver uuid := private.my_driver_id();
begin
  if private.has_permission('dispatch.edit') then
    return private.truck_day_release_core(v_company, p_load, 'dispatch', p_note);
  end if;
  if v_driver is not null and exists (
    select 1 from public.dispatch_assignments a where a.load_id = p_load and a.company_id = v_company and a.status = 'active' and a.driver_id = v_driver
  ) then
    return private.truck_day_release_core(v_company, p_load, 'driver', p_note);
  end if;
  raise exception 'Only dispatch or the truck''s driver can release it.' using errcode = '42501';
end;
$$;
revoke all on function public.truck_day_release(uuid, text) from public, anon;
grant execute on function public.truck_day_release(uuid, text) to authenticated;

-- The customer's site contact, from the portal: only their own company's order, only for their own customer.
create or replace function public.portal_truck_release(p_slug text, p_load uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.portal_accounts%rowtype := private.portal_me(p_slug);
begin
  perform private.portal_require_feature(v.company_id, 'orders');
  if not exists (
    select 1 from public.order_loads l join public.orders o on o.id = l.order_id and o.company_id = l.company_id
    where l.id = p_load and l.company_id = v.company_id and o.customer_id = v.customer_id and o.status <> 'draft'
  ) then
    raise exception 'Truck not found.' using errcode = 'P0002';
  end if;
  return private.truck_day_release_core(v.company_id, p_load, 'site', '') - 'order_number';
end;
$$;
revoke all on function public.portal_truck_release(text, uuid) from public, anon;
grant execute on function public.portal_truck_release(text, uuid) to authenticated;

-- Today's trucks of a truck-day order, for the portal (truck unit only, never the driver's name).
create or replace function public.portal_order_trucks(p_slug text, p_order uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v public.portal_accounts%rowtype := private.portal_me(p_slug);
  v_today date;
begin
  perform private.portal_require_feature(v.company_id, 'orders');
  if not exists (select 1 from public.orders o where o.id = p_order and o.company_id = v.company_id and o.customer_id = v.customer_id and o.status <> 'draft' and o.job_type = 'truck_day') then
    return '[]'::jsonb;
  end if;
  v_today := (now() at time zone private.business_timezone(v.company_id))::date;
  return (select coalesce(jsonb_agg(jsonb_build_object(
            'load_id', l.id, 'truck', t.unit_number, 'start', l.start_time, 'end', l.end_time, 'released_at', l.released_at,
            'started', now() > a.starts_at,
            'trips', (select count(*) from public.delivery_tickets dt where dt.load_id = l.id and dt.status in ('submitted', 'needs_review', 'accepted')))
          order by l.start_time, t.unit_number), '[]'::jsonb)
          from public.order_loads l
          join public.dispatch_assignments a on a.load_id = l.id and a.status = 'active'
          join public.trucks t on t.id = a.truck_id
          where l.order_id = p_order and l.company_id = v.company_id and l.status = 'planned' and l.load_date = v_today);
end;
$$;
revoke all on function public.portal_order_trucks(text, uuid) from public, anon;
grant execute on function public.portal_order_trucks(text, uuid) to authenticated;

-- Company setting (billing.manage). Basis null turns truck-hours off.
create or replace function public.save_truck_hours_settings(p_basis text, p_minimum numeric, p_shortfall text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
begin
  perform private.require_permission('billing.manage');
  if p_basis is not null and p_basis not in ('scheduled', 'arrived') then raise exception 'Choose which hours count.' using errcode = '22023'; end if;
  if p_minimum is not null and (p_minimum <= 0 or p_minimum > 24) then raise exception 'A minimum is above 0 and up to 24 hours, or empty for none.' using errcode = '22023'; end if;
  if coalesce(p_shortfall, '') not in ('bill_minimum', 'review') then raise exception 'Choose what happens below the minimum.' using errcode = '22023'; end if;
  insert into public.truck_hours_settings (company_id, basis, minimum_hours, shortfall, updated_by, updated_at)
  values (v_company, p_basis, p_minimum, p_shortfall, auth.uid(), now())
  on conflict (company_id) do update set basis = excluded.basis, minimum_hours = excluded.minimum_hours, shortfall = excluded.shortfall,
    updated_by = excluded.updated_by, updated_at = excluded.updated_at;
  perform private.log_event('billing.truck_hours_saved', 'truck_hours_settings', v_company,
    case when p_basis is null then 'Truck-hours turned off'
         else format('Truck-hours count from the %s until release%s', case p_basis when 'arrived' then 'recorded arrival' else 'scheduled start' end,
                     case when p_minimum is null then '' else format('; minimum %s h per truck (%s)', p_minimum, case p_shortfall when 'bill_minimum' then 'bill the minimum' else 'flag for review' end) end) end,
    jsonb_build_object('basis', p_basis, 'minimum_hours', p_minimum, 'shortfall', p_shortfall));
end;
$$;
revoke all on function public.save_truck_hours_settings(text, numeric, text) from public, anon;
grant execute on function public.save_truck_hours_settings(text, numeric, text) to authenticated;

-- Truck-hours of one truck-day order (billing.view): one row per assigned slot, computed from the company's setting.
-- Nothing is estimated: a missing arrival or a truck not yet released gives no hours, with the reason.
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
        'driver', coalesce(d.name, ''), 'start', st.start_at, 'released_at', l.released_at, 'release_source', l.release_source,
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

-- Tickets: on a truck-day slot, more tickets are more trips, so the "already has a ticket" confirmation and its review
-- flag do not apply there. private.prepare_ticket is otherwise unchanged from 20261022000100.
CREATE OR REPLACE FUNCTION private.prepare_ticket(p_company uuid, p_payload jsonb, p_except_number text, p_fallback_assignment uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_load       public.order_loads%rowtype;
  v_order      public.orders%rowtype;
  v_assignment public.dispatch_assignments%rowtype;
  v_line       public.order_lines%rowtype;
  v_truck      public.trucks%rowtype;
  v_trailer    public.trailers%rowtype;
  v_driver_id  uuid;
  v_driver     text;
  v_customer   text;
  v_tz         text := private.business_timezone(p_company);
  v_date       date := nullif(p_payload ->> 'delivered_date', '')::date;
  v_time       time := nullif(p_payload ->> 'delivered_time', '')::time;
  v_at         timestamptz;
  v_qty_text   text := trim(coalesce(p_payload ->> 'quantity', ''));
  v_qty        numeric;
  v_unit       text := nullif(trim(coalesce(p_payload ->> 'unit_code', '')), '');
  v_ref        text := private.clean_text(p_payload ->> 'external_reference', 60, 'Ticket reference');
  v_reasons    text[] := '{}';
  v_confirm    boolean := coalesce((p_payload ->> 'confirm_duplicate')::boolean, false);
  v_trailer_id uuid := nullif(p_payload ->> 'trailer_id', '')::uuid;
  v_dupes      text;
begin
  select * into v_load from public.order_loads
  where id = nullif(p_payload ->> 'load_id', '')::uuid and company_id = p_company for update;
  if not found then raise exception 'Load not found.'; end if;
  if v_load.status = 'canceled' then
    raise exception 'Load % is canceled. Tickets can only be entered for planned loads.', v_load.load_number;
  end if;
  select * into v_order from public.orders where id = v_load.order_id;
  if v_order.status not in ('scheduled', 'dispatched', 'in_progress', 'partially_completed', 'completed') then
    raise exception 'Order % is %. Tickets can be entered for scheduled, dispatched, in-progress or completed orders.',
      v_order.order_number, replace(v_order.status::text, '_', ' ');
  end if;
  select * into v_assignment from public.dispatch_assignments where load_id = v_load.id and status = 'active';
  if not found and p_fallback_assignment is not null then
    select * into v_assignment from public.dispatch_assignments
    where id = p_fallback_assignment and load_id = v_load.id and company_id = p_company;
  end if;
  if not found then
    raise exception '% load % has no truck and driver assigned. Assign it on the dispatch board first.',
      v_order.order_number, v_load.load_number;
  end if;

  -- Order line delivered (gives the material); must be a per-unit line of this order.
  select * into v_line from public.order_lines
  where id = nullif(p_payload ->> 'order_line_id', '')::uuid and company_id = p_company and order_id = v_order.id;
  if not found then raise exception 'Choose the order line that was delivered.'; end if;
  if v_line.calc_method <> 'per_unit' or v_line.kind = 'discount' then
    raise exception 'Choose a material or hauling line measured in units.';
  end if;

  -- Actual quantity and unit: required, never defaulted, never converted.
  if v_qty_text = '' then raise exception 'Enter the delivered quantity.'; end if;
  if v_qty_text !~ '^\d{1,6}(\.\d{1,3})?$' then
    raise exception 'Delivered quantity must be a number greater than 0 with at most 3 decimal places.';
  end if;
  v_qty := v_qty_text::numeric;
  if v_qty <= 0 then raise exception 'Delivered quantity must be greater than 0.'; end if;
  if v_unit is null then raise exception 'Choose the unit of the delivered quantity.'; end if;
  if not exists (select 1 from public.units_of_measure where company_id = p_company and code = v_unit) then
    raise exception 'Choose a valid unit.';
  end if;
  if private.unit_requires_whole(v_unit) and v_qty <> trunc(v_qty) then
    raise exception 'Quantities in % must be whole numbers.', v_unit;
  end if;

  -- Delivery time (local business time).
  if v_date is null or v_time is null then raise exception 'Enter the delivery date and time.'; end if;
  v_at := (v_date + v_time) at time zone v_tz;
  if v_at > now() + interval '1 hour' then raise exception 'The delivery time cannot be in the future.'; end if;
  if v_at < now() - interval '1 year' then raise exception 'The delivery time is more than a year ago.'; end if;

  -- Equipment and driver: from the assignment unless the paper ticket shows otherwise.
  select * into v_truck from public.trucks
  where id = coalesce(nullif(p_payload ->> 'truck_id', '')::uuid, v_assignment.truck_id) and company_id = p_company;
  if not found then raise exception 'Truck not found.'; end if;
  if p_payload ? 'trailer_id' then
    if v_trailer_id is not null then
      select * into v_trailer from public.trailers where id = v_trailer_id and company_id = p_company;
      if not found then raise exception 'Trailer not found.'; end if;
    end if;
  else
    v_trailer_id := v_assignment.trailer_id;
    if v_trailer_id is not null then
      select * into v_trailer from public.trailers where id = v_trailer_id;
    end if;
  end if;
  v_driver_id := coalesce(nullif(p_payload ->> 'driver_id', '')::uuid, v_assignment.driver_id);
  select coalesce(nullif(trim(p.full_name), ''), nullif(d.name, ''), 'Unnamed driver') into v_driver
  from public.drivers d left join public.profiles p on p.id = d.user_id
  where d.id = v_driver_id and d.company_id = p_company;
  if v_driver is null then raise exception 'Driver not found.'; end if;
  select name into v_customer from public.customers where id = v_order.customer_id;

  -- Review reasons (never conversions; the office decides).
  if v_line.unit_code is distinct from v_unit then
    v_reasons := v_reasons || 'unit_differs_from_order_line'::text;
  end if;
  if (v_at at time zone v_tz)::date <> v_load.load_date then
    v_reasons := v_reasons || 'delivered_on_other_day'::text;
  end if;
  if (v_truck.id, v_trailer_id, v_driver_id) is distinct from
     (v_assignment.truck_id, v_assignment.trailer_id, v_assignment.driver_id) then
    v_reasons := v_reasons || 'equipment_differs_from_assignment'::text;
  end if;
  -- Company setting: some companies' tickets carry no paper/scale number.
  if v_ref = '' and coalesce((select s.ticket_reference_required from public.company_settings s where s.company_id = p_company), true) then
    v_reasons := v_reasons || 'missing_external_reference'::text;
  end if;

  -- Possible duplicates need an explicit confirmation and are flagged.
  select string_agg(ticket_number, ', ' order by ticket_number) into v_dupes
  from public.delivery_tickets
  where company_id = p_company and load_id = v_load.id and status not in ('voided', 'superseded')
    and ticket_number is distinct from p_except_number;
  -- Truck-day slots (UX11) carry one ticket per trip: several tickets on one slot are the normal case, not a duplicate.
  if v_order.job_type = 'truck_day' then
    v_dupes := null;
  end if;
  if v_dupes is not null then
    if not v_confirm then
      raise exception '% load % already has ticket %. Confirm that this is a separate delivery to add another.',
        v_order.order_number, v_load.load_number, v_dupes using errcode = 'PT422';
    end if;
    v_reasons := v_reasons || 'additional_ticket_for_load'::text;
  end if;
  if v_ref <> '' then
    select string_agg(ticket_number, ', ' order by ticket_number) into v_dupes
    from public.delivery_tickets
    where company_id = p_company and lower(external_reference) = lower(v_ref)
      and status not in ('voided', 'superseded') and ticket_number is distinct from p_except_number;
    if v_dupes is not null then
      if not v_confirm then
        raise exception 'Ticket reference % is already used on %. Confirm to record it again.', v_ref, v_dupes
          using errcode = 'PT422';
      end if;
      v_reasons := v_reasons || 'duplicate_external_reference'::text;
    end if;
  end if;

  return jsonb_build_object(
    'order_id', v_order.id,
    'order_number', v_order.order_number,
    'load_id', v_load.id,
    'assignment_id', v_assignment.id,
    'order_line_id', v_line.id,
    'material_id', v_line.material_id,
    'truck_id', v_truck.id,
    'trailer_id', v_trailer_id,
    'driver_id', v_driver_id,
    'delivered_at', v_at,
    'quantity', v_qty,
    'unit_code', v_unit,
    'external_reference', v_ref,
    'notes', private.clean_text(p_payload ->> 'notes', 2000, 'Notes'),
    'review_reasons', to_jsonb(v_reasons),
    'snapshot', jsonb_build_object(
      'order_number', v_order.order_number,
      'load_number', v_load.load_number,
      'load_date', v_load.load_date,
      'customer_name', v_customer,
      'line_description', v_line.description,
      'line_unit_code', v_line.unit_code,
      'truck_unit', v_truck.unit_number,
      'trailer_unit', v_trailer.unit_number,
      'driver_name', v_driver,
      'planned_quantity', v_load.planned_quantity,
      'planned_unit_code', v_load.unit_code));
end;
$function$;

-- The signed-in driver's own truck-day slots (My Day): released or not, and whether the day has started. Read-only;
-- drivers have no read access to orders or loads themselves.
create or replace function public.driver_truck_days()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('load_id', l.id, 'released_at', l.released_at, 'release_source', l.release_source,
                                               'started', now() > a.starts_at)), '[]'::jsonb)
  from public.dispatch_assignments a
  join public.order_loads l on l.id = a.load_id and l.company_id = a.company_id
  join public.orders o on o.id = l.order_id and o.company_id = l.company_id
  where a.driver_id = private.my_driver_id() and a.company_id = private.current_company_id()
    and a.status = 'active' and l.status = 'planned' and o.job_type = 'truck_day'
    and l.load_date between (now() at time zone private.business_timezone(a.company_id))::date - 1
                        and (now() at time zone private.business_timezone(a.company_id))::date + 7;
$$;
revoke all on function public.driver_truck_days() from public, anon;
grant execute on function public.driver_truck_days() to authenticated;
