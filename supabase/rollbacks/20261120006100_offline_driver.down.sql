-- Rollback for 20261120006100_offline_driver.sql: drops load_stop_mark_at and restores inspection_submit from
-- 20261120006000 (today only). Recorded times and inspections stay.
begin;
drop function if exists public.load_stop_mark_at(uuid, text, text, timestamptz);
create or replace function public.inspection_submit(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v_truck uuid := nullif(p ->> 'truck_id', '')::uuid;
  v_day date := private.company_today(v_company);
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
    raise exception 'This truck already has a % inspection today.', replace(v_kind, '_', '-') using errcode = '23505';
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
    raise exception 'Check the odometer.' using errcode = '22023';
end;
$$;

commit;
