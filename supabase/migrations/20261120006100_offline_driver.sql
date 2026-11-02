-- B133 offline driver app (owner 2026-11-02: cached day + queued sends). A driver without signal can still tap
-- Arrived/Left and record an inspection; the phone keeps them and sends them when signal returns. These two changes let
-- the late send keep what really happened, within tight limits:
--   * load_stop_mark_at: the time the driver tapped, at most 16 hours back and never in the future (2 minutes of clock
--     slack); a departure never before its arrival. load_stop_mark (tap time = now) is unchanged.
--   * inspection_submit: an optional inspected_on, today or yesterday only (default today).
-- Non-destructive: a new function and a replaced one.

create or replace function public.load_stop_mark_at(p_load uuid, p_stop text, p_event text, p_at timestamptz)
returns void
language plpgsql
security definer
set search_path = ''
as $$
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
$$;
revoke all on function public.load_stop_mark_at(uuid, text, text, timestamptz) from public, anon;
grant execute on function public.load_stop_mark_at(uuid, text, text, timestamptz) to authenticated;

create or replace function public.inspection_submit(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v_truck uuid := nullif(p ->> 'truck_id', '')::uuid;
  v_today date := private.company_today(v_company);
  v_day date;
  v_kind text := p ->> 'kind';
  v_items jsonb := coalesce(p -> 'items', '[]'::jsonb);
  v_driver uuid;
  v_defects jsonb;
  v_safety boolean;
  v_unit text;
  v_id uuid;
  v_wo_id uuid;
  v_number text;
begin
  -- Saved on the phone without signal and sent later (B133): the day it was done, today or yesterday only.
  v_day := coalesce(nullif(p ->> 'inspected_on', '')::date, v_today);
  if v_day not in (v_today, v_today - 1) then
    raise exception 'An inspection can be sent for today or yesterday only.' using errcode = '22023';
  end if;
  v_driver := private.fuel_writer(v_company, v_truck, v_day);
  if v_kind not in ('pre_trip', 'post_trip') then
    raise exception 'Choose pre-trip or post-trip.' using errcode = '22023';
  end if;
  if jsonb_typeof(v_items) <> 'array'
     or jsonb_array_length(v_items) <> (select count(*) from private.inspection_items())
     or (select count(distinct e ->> 'key') from jsonb_array_elements(v_items) e where (e ->> 'key') in (select key from private.inspection_items())) <> (select count(*) from private.inspection_items())
     or exists (select 1 from jsonb_array_elements(v_items) e where jsonb_typeof(e -> 'ok') is distinct from 'boolean') then
    raise exception 'Check every item.' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(v_items) e where not (e ->> 'ok')::boolean and length(trim(coalesce(e ->> 'note', ''))) < 3) then
    raise exception 'Describe each defect.' using errcode = '22023';
  end if;
  if exists (select 1 from public.vehicle_inspections where truck_id = v_truck and inspected_on = v_day and kind = v_kind) then
    raise exception 'This truck already has a % inspection for that day.', replace(v_kind, '_', '-') using errcode = '23505';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('key', e ->> 'key', 'note', left(trim(e ->> 'note'), 300), 'safety', i.safety)), '[]'::jsonb),
         coalesce(bool_or(i.safety), false)
    into v_defects, v_safety
  from jsonb_array_elements(v_items) e join private.inspection_items() i on i.key = e ->> 'key'
  where not (e ->> 'ok')::boolean;
  insert into public.vehicle_inspections (company_id, truck_id, driver_id, kind, inspected_on, odometer, items, defect_count, safety_defect, remarks, created_by)
  values (v_company, v_truck, v_driver, v_kind, v_day, nullif(p ->> 'odometer', '')::integer,
          (select jsonb_agg(jsonb_build_object('key', e ->> 'key', 'ok', (e ->> 'ok')::boolean, 'note', left(trim(coalesce(e ->> 'note', '')), 300))) from jsonb_array_elements(v_items) e),
          jsonb_array_length(v_defects), v_safety, private.clean_text(p ->> 'remarks', 1000, 'Remarks'), auth.uid())
  returning id into v_id;

  if jsonb_array_length(v_defects) > 0 then
    select unit_number into v_unit from public.trucks where id = v_truck;
    v_number := private.next_document_number(v_company, 'work_order');
    insert into public.work_orders (company_id, number, truck_id, driver_id, title, description, category, urgency, safety_critical, status, source, created_by)
    values (v_company, v_number, v_truck, v_driver,
            left(format('%s inspection defect%s — truck %s', case v_kind when 'pre_trip' then 'Pre-trip' else 'Post-trip' end, case when jsonb_array_length(v_defects) > 1 then 's' else '' end, v_unit), 120),
            left((select string_agg(format('%s: %s', replace(d ->> 'key', '_', ' '), d ->> 'note'), E'\n') from jsonb_array_elements(v_defects) d), 4000),
            'inspection', case when v_safety then 'immediate' else 'normal' end, v_safety, 'reported', 'inspection', auth.uid())
    returning id into v_wo_id;
    perform private.wo_event(v_company, v_wo_id, 'created', null, 'reported', 'From a driver inspection');
    if v_safety then
      perform private.wo_restrict_truck(v_wo_id);
    end if;
    update public.vehicle_inspections set work_order_id = v_wo_id where id = v_id;
  end if;
  perform private.log_event('inspection.submitted', 'vehicle_inspection', v_id,
    format('%s inspection: %s defect(s)', replace(v_kind, '_', '-'), jsonb_array_length(v_defects)), jsonb_build_object('work_order', v_number));
  return jsonb_build_object('id', v_id, 'defects', jsonb_array_length(v_defects), 'safety', v_safety, 'work_order', v_number);
exception
  when invalid_text_representation or numeric_value_out_of_range then
    raise exception 'Check the odometer and the day.' using errcode = '22023';
end;
$$;

