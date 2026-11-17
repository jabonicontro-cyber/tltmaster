-- The work order a driver's inspection defect opens says what is broken (walkthrough P10, 2026-11-16).
--
-- Before: "Pre-trip inspection defect: truck 103", category Inspection (so the finished job asked for an annual
-- inspection certificate) and a description keyed by the item's code ("tarp: Tarp torn at front corner").
-- Now: "Tarp: Torn at front corner (pre-trip, truck 103)" for one defect, "Tires, Horn: 2 defects (post-trip, truck 103)"
-- for several; the category is the repair it needs (brakes, tires, electrical, hydraulics, body), "repair" when the
-- defects need different kinds of work; the description lists each item by its name. The source stays "inspection",
-- so the work order still shows it came from a driver inspection.
--
-- public.inspection_submit is re-created from its latest definition (20261120007200_plain_dashes.sql) with only the
-- work order's title, description and category changed; every check, the restriction of the truck on a safety defect
-- and the result are as before. Work orders already created are not changed. Rollback:
-- supabase/rollbacks/20261120024200_defect_work_order_title.down.sql.

-- An item's name as the driver saw it (src/lib/inspections/items.ts); the key with spaces for an unknown one.
create or replace function private.inspection_item_label(p_key text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_key
    when 'service_brakes' then 'Service brakes'
    when 'parking_brake' then 'Parking brake'
    when 'steering' then 'Steering'
    when 'lights_reflectors' then 'Lights and reflectors'
    when 'tires' then 'Tires'
    when 'wheels_rims' then 'Wheels and rims'
    when 'coupling' then 'Coupling devices'
    when 'horn' then 'Horn'
    when 'wipers' then 'Windshield wipers'
    when 'mirrors' then 'Rear-view mirrors'
    when 'emergency_equipment' then 'Emergency equipment'
    when 'air_lines' then 'Air lines and tanks'
    when 'hoist_body' then 'Hoist and dump body'
    when 'pto' then 'PTO (power take-off)'
    when 'tarp' then 'Tarp'
    when 'tailgate' then 'Tailgate and latches'
    else initcap(replace(coalesce(p_key, ''), '_', ' '))
  end;
$$;
revoke all on function private.inspection_item_label(text) from public, anon, authenticated;

-- The kind of repair a defective item needs (work order categories, src/lib/maintenance.ts WO_CATEGORIES).
create or replace function private.inspection_defect_category(p_key text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_key in ('service_brakes', 'parking_brake', 'air_lines') then 'brakes'
    when p_key in ('tires', 'wheels_rims') then 'tires'
    when p_key in ('lights_reflectors', 'horn') then 'electrical'
    when p_key in ('hoist_body', 'pto') then 'hydraulics'
    when p_key in ('tarp', 'tailgate', 'mirrors') then 'body'
    when p_key = 'emergency_equipment' then 'other'
    else 'repair'
  end;
$$;
revoke all on function private.inspection_defect_category(text) from public, anon, authenticated;

-- The work order's title for the defects of one inspection, at most 120 characters, the truck always kept.
create or replace function private.inspection_defect_title(p_defects jsonb, p_kind text, p_unit text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_suffix text := format(' (%s, truck %s)', case p_kind when 'pre_trip' then 'pre-trip' else 'post-trip' end, coalesce(p_unit, ''));
  v_head text;
  v_note text;
  v_room integer;
begin
  if jsonb_array_length(p_defects) = 1 then
    v_head := private.inspection_item_label(p_defects -> 0 ->> 'key');
    v_note := trim(coalesce(p_defects -> 0 ->> 'note', ''));
    v_note := upper(left(v_note, 1)) || substr(v_note, 2);
    v_room := 120 - length(v_suffix) - length(v_head) - 2;
    if v_room < 8 then
      return left(v_head || v_suffix, 120);
    end if;
    if length(v_note) > v_room then
      v_note := rtrim(left(v_note, v_room - 3)) || '...';
    end if;
    return v_head || ': ' || v_note || v_suffix;
  end if;
  v_head := (select string_agg(case when d.n = 1 then private.inspection_item_label(d.e ->> 'key') else lower(private.inspection_item_label(d.e ->> 'key')) end, ', ' order by d.n)
             from jsonb_array_elements(p_defects) with ordinality d (e, n));
  v_note := format(': %s defects', jsonb_array_length(p_defects));
  v_room := 120 - length(v_suffix) - length(v_note);
  if length(v_head) > v_room then
    v_head := rtrim(left(v_head, v_room - 3), ', ') || '...';
  end if;
  return v_head || v_note || v_suffix;
end;
$$;
revoke all on function private.inspection_defect_title(jsonb, text, text) from public, anon, authenticated;

create or replace function public.inspection_submit(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_company uuid := private.require_company();
  v_truck uuid := nullif(p ->> 'truck_id', '')::uuid;
  v_today date := private.company_today(v_company);
  v_day date;
  v_expected integer;
  v_kind text := p ->> 'kind';
  v_items jsonb := coalesce(p -> 'items', '[]'::jsonb);
  v_driver uuid;
  v_defects jsonb;
  v_safety boolean;
  v_unit text;
  v_id uuid;
  v_wo_id uuid;
  v_number text;
  v_category text;
begin
  -- Saved on the phone without signal and sent later (B133): the day it was done, today or yesterday only.
  v_day := coalesce(nullif(p ->> 'inspected_on', '')::date, v_today);
  if v_day not in (v_today, v_today - 1) then
    raise exception 'An inspection can be sent for today or yesterday only.' using errcode = '22023';
  end if;
  v_driver := private.fuel_writer(v_company, v_truck, v_day);
  select count(*) into v_expected from private.inspection_items_for(v_truck);
  if v_kind not in ('pre_trip', 'post_trip') then
    raise exception 'Choose pre-trip or post-trip.' using errcode = '22023';
  end if;
  if jsonb_typeof(v_items) <> 'array'
     or jsonb_array_length(v_items) <> v_expected
     or (select count(distinct e ->> 'key') from jsonb_array_elements(v_items) e where (e ->> 'key') in (select key from private.inspection_items_for(v_truck))) <> v_expected
     or exists (select 1 from jsonb_array_elements(v_items) e where jsonb_typeof(e -> 'ok') is distinct from 'boolean') then
    raise exception 'Check every item.' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(v_items) e where not (e ->> 'ok')::boolean and length(trim(coalesce(e ->> 'note', ''))) < 3) then
    raise exception 'Describe each defect.' using errcode = '22023';
  end if;
  if exists (select 1 from public.vehicle_inspections where truck_id = v_truck and inspected_on = v_day and kind = v_kind) then
    raise exception 'This truck already has a % inspection for that day.', replace(v_kind, '_', '-') using errcode = '23505';
  end if;
  -- In the order the driver went through the items, so the title names the first one first.
  select coalesce(jsonb_agg(jsonb_build_object('key', e.value ->> 'key', 'note', left(trim(e.value ->> 'note'), 300), 'safety', i.safety) order by e.n), '[]'::jsonb),
         coalesce(bool_or(i.safety), false)
    into v_defects, v_safety
  from jsonb_array_elements(v_items) with ordinality e (value, n)
  join private.inspection_items_for(v_truck) i on i.key = e.value ->> 'key'
  where not (e.value ->> 'ok')::boolean;
  insert into public.vehicle_inspections (company_id, truck_id, driver_id, kind, inspected_on, odometer, items, defect_count, safety_defect, remarks, created_by)
  values (v_company, v_truck, v_driver, v_kind, v_day, nullif(p ->> 'odometer', '')::integer,
          (select jsonb_agg(jsonb_build_object('key', e ->> 'key', 'ok', (e ->> 'ok')::boolean, 'note', left(trim(coalesce(e ->> 'note', '')), 300))) from jsonb_array_elements(v_items) e),
          jsonb_array_length(v_defects), v_safety, private.clean_text(p ->> 'remarks', 1000, 'Remarks'), auth.uid())
  returning id into v_id;

  if jsonb_array_length(v_defects) > 0 then
    select unit_number into v_unit from public.trucks where id = v_truck;
    v_number := private.next_document_number(v_company, 'work_order');
    -- One kind of repair for every defect: that category; otherwise a general repair.
    select case when count(distinct c) = 1 then min(c) else 'repair' end into v_category
      from (select private.inspection_defect_category(d ->> 'key') c from jsonb_array_elements(v_defects) d) x;
    insert into public.work_orders (company_id, number, truck_id, driver_id, title, description, category, urgency, safety_critical, status, source, created_by)
    values (v_company, v_number, v_truck, v_driver,
            private.inspection_defect_title(v_defects, v_kind, v_unit),
            left((select string_agg(format('%s: %s', private.inspection_item_label(d ->> 'key'), d ->> 'note'), E'\n') from jsonb_array_elements(v_defects) d), 4000),
            v_category, case when v_safety then 'immediate' else 'normal' end, v_safety, 'reported', 'inspection', auth.uid())
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
$function$;
