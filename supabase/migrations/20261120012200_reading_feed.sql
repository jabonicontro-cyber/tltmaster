-- =============================================================================
-- Odometer and engine-hour readings from every place they are entered (2026-11-09).
--
-- Preventive schedules use public.truck_readings (the latest reading per truck). Until now only the Preventive page
-- recorded readings, so the odometer a driver wrote on a pre-trip, a trip sheet or a fuel entry, and the mechanic's
-- reading when finishing a job, never reached the schedules: "due by miles" stayed stale or unknown.
--
-- Now one shared path, private.feed_truck_reading, records a reading from each of them (triggers, so every caller is
-- covered: the office, the driver's phone, readings sent later from a phone without signal):
--   * vehicle_inspections.odometer        (pre-trip and post-trip)           source 'inspection'
--   * trip_sheets end (or start) odometer (not voided)                        source 'trip_sheet'
--   * fuel_purchases.odometer             (not voided)                        source 'fuel'
--   * work_orders.odometer_at_service / engine_hours_at_service (trucks)      source 'work_order'
-- A reading never lowers the truck's current one. A value lower than the current reading (a typo, or an older
-- paper entered late) is not used; neither is a jump no truck could drive since the last reading (more than 2,000
-- miles or 24 engine hours per day since then). Each value not used is recorded in the audit log
-- ('truck.reading_ignored', on the truck) with where it came from, so nothing is dropped silently; the source record
-- keeps what was written. The same value as the current reading adds nothing.
--
-- public.truck_readings gains `source` (manual by default: the Preventive page, unchanged) and `source_id` (the
-- record it came from). Readings are still written only by functions; RLS unchanged.
-- Additive; works with the code before and after it.
-- Reversible: supabase/rollbacks/20261120012200_reading_feed.down.sql
-- =============================================================================

alter table public.truck_readings add column source text not null default 'manual'
  check (source in ('manual', 'inspection', 'trip_sheet', 'fuel', 'work_order'));
alter table public.truck_readings add column source_id uuid;
comment on column public.truck_readings.source is
  'Where the reading was entered: manual (Preventive page), inspection, trip_sheet, fuel or work_order.';

-- Record a reading for a truck from another record. Returns what happened per value, e.g.
-- {"miles": "recorded", "hours": "none"}; values: recorded, same, lower, implausible, none.
create or replace function private.feed_truck_reading(
  p_company uuid, p_truck uuid, p_miles numeric, p_hours numeric, p_source text, p_source_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_unit   text;
  v_miles  numeric;  v_miles_at timestamptz;
  v_hours  numeric;  v_hours_at timestamptz;
  v_days   numeric;
  v_use_m  numeric;
  v_use_h  numeric;
  v_m      text := 'none';
  v_h      text := 'none';
  v_from   text := case p_source when 'inspection' then 'an inspection' when 'trip_sheet' then 'a trip sheet'
                                 when 'fuel' then 'a fuel entry' when 'work_order' then 'a work order' else 'an entry' end;
begin
  if p_truck is null or (p_miles is null and p_hours is null) then
    return jsonb_build_object('miles', v_m, 'hours', v_h);
  end if;
  select unit_number into v_unit from public.trucks where id = p_truck and company_id = p_company for update;
  if not found then
    return jsonb_build_object('miles', v_m, 'hours', v_h);
  end if;
  select max(r.odometer_miles), max(r.read_at) filter (where r.odometer_miles is not null),
         max(r.engine_hours), max(r.read_at) filter (where r.engine_hours is not null)
    into v_miles, v_miles_at, v_hours, v_hours_at
  from public.truck_readings r where r.company_id = p_company and r.truck_id = p_truck;

  if p_miles is not null and p_miles >= 0 and p_miles <= 9999999 then
    v_days := greatest(1, ceil(extract(epoch from (clock_timestamp() - coalesce(v_miles_at, clock_timestamp()))) / 86400));
    if v_miles is null or (p_miles > v_miles and p_miles - v_miles <= 2000 * v_days) then
      v_use_m := p_miles; v_m := 'recorded';
    elsif p_miles = v_miles then v_m := 'same';
    elsif p_miles < v_miles then v_m := 'lower';
    else v_m := 'implausible';
    end if;
  end if;
  if p_hours is not null and p_hours >= 0 and p_hours <= 999999 then
    v_days := greatest(1, ceil(extract(epoch from (clock_timestamp() - coalesce(v_hours_at, clock_timestamp()))) / 86400));
    if v_hours is null or (p_hours > v_hours and p_hours - v_hours <= 24 * v_days) then
      v_use_h := p_hours; v_h := 'recorded';
    elsif p_hours = v_hours then v_h := 'same';
    elsif p_hours < v_hours then v_h := 'lower';
    else v_h := 'implausible';
    end if;
  end if;

  if v_use_m is not null or v_use_h is not null then
    begin
      insert into public.truck_readings (company_id, truck_id, odometer_miles, engine_hours, note, recorded_by, source, source_id)
      values (p_company, p_truck, v_use_m, v_use_h, left('From ' || v_from, 300), auth.uid(), p_source, p_source_id);
    exception when insufficient_privilege then
      -- A person limited to other dispatch bases: the source record is kept; the reading is left for the shop.
      v_m := case when v_m = 'recorded' then 'none' else v_m end;
      v_h := case when v_h = 'recorded' then 'none' else v_h end;
    end;
  end if;
  if v_m in ('lower', 'implausible') then
    insert into public.audit_events (company_id, actor_id, action, entity_type, entity_id, summary, details)
    values (p_company, auth.uid(), 'truck.reading_ignored', 'truck', p_truck,
      left(format('Odometer %s mi from %s on truck %s was not used: %s the current %s mi.', p_miles, v_from, v_unit,
        case v_m when 'lower' then 'lower than' else 'too far above' end, v_miles), 500),
      jsonb_build_object('value', p_miles, 'current', v_miles, 'kind', 'odometer', 'why', v_m, 'source', p_source, 'source_id', p_source_id));
  end if;
  if v_h in ('lower', 'implausible') then
    insert into public.audit_events (company_id, actor_id, action, entity_type, entity_id, summary, details)
    values (p_company, auth.uid(), 'truck.reading_ignored', 'truck', p_truck,
      left(format('Engine hours %s from %s on truck %s were not used: %s the current %s h.', p_hours, v_from, v_unit,
        case v_h when 'lower' then 'lower than' else 'too far above' end, v_hours), 500),
      jsonb_build_object('value', p_hours, 'current', v_hours, 'kind', 'engine_hours', 'why', v_h, 'source', p_source, 'source_id', p_source_id));
  end if;
  return jsonb_build_object('miles', v_m, 'hours', v_h);
end;
$$;
revoke all on function private.feed_truck_reading(uuid, uuid, numeric, numeric, text, uuid) from public, anon, authenticated;

create or replace function private.reading_from_record()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_table_name = 'vehicle_inspections' then
    perform private.feed_truck_reading(new.company_id, new.truck_id, new.odometer, null, 'inspection', new.id);
  elsif tg_table_name = 'trip_sheets' then
    if not new.voided then
      perform private.feed_truck_reading(new.company_id, new.truck_id, coalesce(new.end_odometer, new.start_odometer), null, 'trip_sheet', new.id);
    end if;
  elsif tg_table_name = 'fuel_purchases' then
    if not new.voided then
      perform private.feed_truck_reading(new.company_id, new.truck_id, new.odometer, null, 'fuel', new.id);
    end if;
  elsif tg_table_name = 'work_orders' then
    if new.truck_id is not null and (tg_op = 'INSERT'
        or new.odometer_at_service is distinct from old.odometer_at_service
        or new.engine_hours_at_service is distinct from old.engine_hours_at_service) then
      perform private.feed_truck_reading(new.company_id, new.truck_id,
        case when tg_op = 'INSERT' or new.odometer_at_service is distinct from old.odometer_at_service then new.odometer_at_service end,
        case when tg_op = 'INSERT' or new.engine_hours_at_service is distinct from old.engine_hours_at_service then new.engine_hours_at_service end,
        'work_order', new.id);
    end if;
  end if;
  return null;
end;
$$;
revoke all on function private.reading_from_record() from public, anon, authenticated;

create trigger vehicle_inspections_reading after insert on public.vehicle_inspections
  for each row when (new.odometer is not null) execute function private.reading_from_record();
create trigger trip_sheets_reading after insert on public.trip_sheets
  for each row when (new.end_odometer is not null or new.start_odometer is not null) execute function private.reading_from_record();
create trigger fuel_purchases_reading after insert on public.fuel_purchases
  for each row when (new.odometer is not null) execute function private.reading_from_record();
create trigger work_orders_reading after insert or update of odometer_at_service, engine_hours_at_service on public.work_orders
  for each row when (new.odometer_at_service is not null or new.engine_hours_at_service is not null)
  execute function private.reading_from_record();
