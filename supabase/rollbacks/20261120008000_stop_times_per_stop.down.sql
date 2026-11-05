-- Rollback of 20261120008000_stop_times_per_stop.sql: per-stop times are removed (pickup and job site times stay),
-- and the functions accept only 'pickup' and 'site' again.
delete from public.load_stop_times where order_stop_id is not null;

CREATE OR REPLACE FUNCTION public.load_stop_mark(p_load uuid, p_stop text, p_event text, p_location uuid DEFAULT NULL::uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  r record;
  v_row public.load_stop_times;
begin
  if p_stop not in ('pickup', 'site') or p_event not in ('arrive', 'depart') then
    raise exception 'Choose the stop and whether you arrived or left.' using errcode = '22023';
  end if;
  select * into r from private.stop_time_writer(p_load);
  if p_location is not null and (p_stop <> 'pickup' or not exists (
       select 1 from public.company_locations c where c.id = p_location and c.company_id = r.company_id and c.active)) then
    raise exception 'Location not found.' using errcode = 'P0002';
  end if;
  select * into v_row from public.load_stop_times where load_id = p_load and stop = p_stop;
  if p_event = 'depart' and v_row.arrived_at is null then
    raise exception 'Tap Arrived first.' using errcode = '22023';
  end if;
  insert into public.load_stop_times (company_id, load_id, order_id, stop, location_id, arrived_at, departed_at, source)
  values (r.company_id, p_load, r.order_id, p_stop, p_location, case when p_event = 'arrive' then now() end,
          null, case when r.own then 'driver' else 'office' end)
  on conflict (load_id, stop) do update set
    arrived_at = coalesce(public.load_stop_times.arrived_at, excluded.arrived_at),
    departed_at = case when p_event = 'depart' then coalesce(public.load_stop_times.departed_at, now()) else public.load_stop_times.departed_at end,
    location_id = coalesce(excluded.location_id, public.load_stop_times.location_id),
    entered_by = auth.uid(), updated_at = now();
end;
$function$;

CREATE OR REPLACE FUNCTION public.load_stop_mark_at(p_load uuid, p_stop text, p_event text, p_at timestamp with time zone)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  r record;
  v_row public.load_stop_times;
begin
  if p_stop not in ('pickup', 'site') or p_event not in ('arrive', 'depart') then
    raise exception 'Choose the stop and whether you arrived or left.' using errcode = '22023';
  end if;
  if p_at is null or p_at > now() + interval '2 minutes' or p_at < now() - interval '16 hours' then
    raise exception 'That time is too old to record from the phone; tell the office.' using errcode = '22023';
  end if;
  select * into r from private.stop_time_writer(p_load);
  select * into v_row from public.load_stop_times where load_id = p_load and stop = p_stop;
  if p_event = 'depart' and v_row.arrived_at is null then
    raise exception 'Tap Arrived first.' using errcode = '22023';
  end if;
  if p_event = 'depart' and p_at < v_row.arrived_at then
    raise exception 'Left cannot be before Arrived.' using errcode = '22023';
  end if;
  insert into public.load_stop_times (company_id, load_id, order_id, stop, arrived_at, departed_at, source)
  values (r.company_id, p_load, r.order_id, p_stop, case when p_event = 'arrive' then p_at end,
          null, case when r.own then 'driver' else 'office' end)
  on conflict (load_id, stop) do update set
    arrived_at = coalesce(public.load_stop_times.arrived_at, excluded.arrived_at),
    departed_at = case when p_event = 'depart' then coalesce(public.load_stop_times.departed_at, p_at) else public.load_stop_times.departed_at end,
    entered_by = auth.uid(), updated_at = now();
end;
$function$;

CREATE OR REPLACE FUNCTION public.load_stop_set(p_load uuid, p_stop text, p_arrived timestamp with time zone, p_departed timestamp with time zone, p_location uuid DEFAULT NULL::uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  r record;
begin
  perform private.require_permission('dispatch.edit');
  if p_stop not in ('pickup', 'site') then
    raise exception 'Choose the stop.' using errcode = '22023';
  end if;
  select * into r from private.stop_time_writer(p_load);
  if p_arrived is null or p_arrived > now() + interval '5 minutes' or p_arrived < now() - interval '14 days'
     or (p_departed is not null and (p_departed < p_arrived or p_departed > now() + interval '5 minutes')) then
    raise exception 'Arrival is within the last 14 days and departure after it, not in the future.' using errcode = '22023';
  end if;
  if p_location is not null and (p_stop <> 'pickup' or not exists (
       select 1 from public.company_locations c where c.id = p_location and c.company_id = r.company_id)) then
    raise exception 'Location not found.' using errcode = 'P0002';
  end if;
  insert into public.load_stop_times (company_id, load_id, order_id, stop, location_id, arrived_at, departed_at, source)
  values (r.company_id, p_load, r.order_id, p_stop, p_location, p_arrived, p_departed, 'office')
  on conflict (load_id, stop) do update set arrived_at = excluded.arrived_at, departed_at = excluded.departed_at,
    location_id = coalesce(excluded.location_id, public.load_stop_times.location_id), source = 'office', entered_by = auth.uid(), updated_at = now();
  perform private.log_event('wait_time.corrected', 'order', r.order_id,
    format('%s times entered by the office', case p_stop when 'pickup' then 'Pickup' else 'Job site' end),
    jsonb_build_object('load_id', p_load, 'stop', p_stop, 'arrived_at', p_arrived, 'departed_at', p_departed));
end;
$function$;

alter table public.load_stop_times drop constraint load_stop_times_stop_check;
alter table public.load_stop_times add constraint load_stop_times_stop_check check (stop in ('pickup', 'site'));
drop index if exists public.load_stop_times_order_stop_idx;
alter table public.load_stop_times drop column order_stop_id;
drop function if exists private.order_stop_for(uuid, text);

-- The driver's stops without their id (20261120007800).
-- The stops of the signed-in driver's own loads (two days back to tomorrow), keyed by load, in order. Nothing about
-- other drivers or other loads.
create or replace function public.driver_load_stops()
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
    select jsonb_object_agg(x.load_id, x.stops)
    from (
      select l.id as load_id,
             jsonb_agg(jsonb_build_object(
               'seq', s.seq, 'kind', s.kind, 'name', s.name,
               'address', concat_ws(', ', nullif(s.address_line1, ''), nullif(s.city, ''),
                                    nullif(concat_ws(' ', nullif(s.state, ''), nullif(s.postal_code, '')), '')),
               'appointment_date', s.appointment_date, 'window_start', s.window_start, 'window_end', s.window_end,
               'reference', s.reference, 'notes', s.notes) order by s.seq) as stops
      from public.dispatch_assignments a
      join public.order_loads l on l.id = a.load_id and l.company_id = a.company_id
      join public.order_stops s on s.order_id = l.order_id and s.company_id = l.company_id and s.removed_at is null
      where a.company_id = v_d.company_id and a.driver_id = v_d.id and a.status = 'active'
        and l.load_date between v_today - 2 and v_today + 1
      group by l.id
    ) x), '{}'::jsonb);
end;
$$;
revoke all on function public.driver_load_stops() from public, anon;
grant execute on function public.driver_load_stops() to authenticated;
