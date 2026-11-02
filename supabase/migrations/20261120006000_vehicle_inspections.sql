-- B132 digital inspections (owner 2026-11-02: a missing pre-trip is flagged, never blocking). Drivers record pre-trip
-- and post-trip inspections on the standard DVIR items (49 CFR 396.11). Every defect opens a work order (source
-- 'inspection'); a defect in a safety item (brakes, parking brake, steering, lights, tires, wheels, coupling) makes it
-- safety-critical, which takes the truck out of service through the existing maintenance rule until a mechanic clears
-- it. Non-destructive: a new table and functions; the work_orders source check gains 'inspection'.

alter table public.work_orders drop constraint work_orders_source_check;
alter table public.work_orders add constraint work_orders_source_check check (source in ('manual', 'field_report', 'preventive', 'inspection'));

create table public.vehicle_inspections (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.companies (id),
  truck_id       uuid not null,
  driver_id      uuid,
  kind           text not null check (kind in ('pre_trip', 'post_trip')),
  inspected_on   date not null,
  odometer       integer check (odometer is null or odometer between 0 and 9999999),
  -- [{"key":"service_brakes","ok":true,"note":""}, …] for every DVIR item.
  items          jsonb not null,
  defect_count   integer not null default 0,
  safety_defect  boolean not null default false,
  remarks        text not null default '' check (length(remarks) <= 1000),
  work_order_id  uuid references public.work_orders (id) on delete set null,
  created_by     uuid references auth.users (id) on delete set null,
  created_at     timestamptz not null default now(),
  foreign key (company_id, truck_id) references public.trucks (company_id, id),
  foreign key (company_id, driver_id) references public.drivers (company_id, id)
);
create index vehicle_inspections_company_day on public.vehicle_inspections (company_id, inspected_on);
create unique index vehicle_inspections_one_per_kind on public.vehicle_inspections (truck_id, inspected_on, kind);
alter table public.vehicle_inspections enable row level security;
create policy vehicle_inspections_read on public.vehicle_inspections for select to authenticated
  using (company_id = (select private.current_company_id())
         and ((select private.has_permission('fleet.view')) or (select private.has_permission('maintenance.view'))
              or driver_id = (select private.my_driver_id())));
revoke all on public.vehicle_inspections from anon;
grant select on public.vehicle_inspections to authenticated;

-- The DVIR items and which are safety items.
create or replace function private.inspection_items()
returns table (key text, safety boolean)
language sql
immutable
set search_path = ''
as $$
  values ('service_brakes', true), ('parking_brake', true), ('steering', true), ('lights_reflectors', true), ('tires', true),
         ('wheels_rims', true), ('coupling', true), ('horn', false), ('wipers', false), ('mirrors', false), ('emergency_equipment', false);
$$;
revoke all on function private.inspection_items() from public, anon, authenticated;

-- Record an inspection. Same people as fuel and trip sheets (private.fuel_writer): the office, or a driver for a truck
-- they drive that day or their own truck. Defects open one work order for the truck.
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

-- My Day: the trucks the signed-in driver may inspect today and which inspections are in.
create or replace function public.inspection_my_trucks()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with d as (select private.company_today(private.current_company_id()) as day where private.current_company_id() is not null)
  select coalesce(jsonb_agg(jsonb_build_object('id', t ->> 'id', 'unit', t ->> 'unit',
           'pre_trip', exists (select 1 from public.vehicle_inspections v where v.truck_id = (t ->> 'id')::uuid and v.inspected_on = d.day and v.kind = 'pre_trip'),
           'post_trip', exists (select 1 from public.vehicle_inspections v where v.truck_id = (t ->> 'id')::uuid and v.inspected_on = d.day and v.kind = 'post_trip'))), '[]'::jsonb)
  from d, jsonb_array_elements(public.fuel_my_trucks(d.day)) t;
$$;

-- Office: today's working trucks (an active assignment today) without a pre-trip inspection.
create or replace function public.inspection_missing_today()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v_day date := private.company_today(v_company);
begin
  if not (private.has_permission('fleet.view') or private.has_permission('dispatch.view')) then
    raise exception 'Not allowed.' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('truck_id', t.id, 'unit', t.unit_number) order by t.unit_number)
    from public.trucks t
    where t.company_id = v_company and t.active and t.hauler_id is null
      and exists (select 1 from public.dispatch_assignments a join public.order_loads l on l.id = a.load_id
                  where a.company_id = v_company and a.truck_id = t.id and l.load_date = v_day and a.status = 'active')
      and not exists (select 1 from public.vehicle_inspections v where v.truck_id = t.id and v.inspected_on = v_day and v.kind = 'pre_trip')), '[]'::jsonb);
end;
$$;

-- Demo sample: pre-trip inspections on the last weekdays for the demo's working trucks, one with a minor defect (a
-- normal work order, the truck stays in service). Today is left open so the missing pre-trip shows. Fictional; once.
create or replace function public.demo_inspection_samples()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_demo uuid := private.demo_owner_company();
  v_today date;
  v_day date;
  v_truck record;
  v_items jsonb;
  v_n integer := 0;
  v_i integer;
  v_wo uuid;
begin
  if v_demo is null then
    raise exception 'Demo samples are only added to a demo company, by its owner.' using errcode = '42501';
  end if;
  if exists (select 1 from public.vehicle_inspections where company_id = v_demo) then
    return 0;
  end if;
  v_today := private.company_today(v_demo);
  v_items := (select jsonb_agg(jsonb_build_object('key', key, 'ok', true, 'note', '')) from private.inspection_items());
  for v_truck in select id, unit_number from public.trucks where company_id = v_demo and active and hauler_id is null and service_status = 'in_service' order by unit_number limit 4 loop
    for v_i in 1..6 loop
      v_day := v_today - v_i;
      continue when extract(isodow from v_day) > 5;
      insert into public.vehicle_inspections (company_id, truck_id, kind, inspected_on, items, created_by)
      values (v_demo, v_truck.id, 'pre_trip', v_day, v_items, auth.uid())
      on conflict do nothing;
      v_n := v_n + 1;
    end loop;
  end loop;
  -- One minor defect yesterday-ish on the first truck: a work order, the truck stays in service.
  select id into v_truck from public.trucks where company_id = v_demo and active and hauler_id is null and service_status = 'in_service' order by unit_number limit 1;
  if found then
    v_day := v_today - 1;
    while extract(isodow from v_day) > 5 loop v_day := v_day - 1; end loop;
    insert into public.work_orders (company_id, number, truck_id, title, description, category, urgency, safety_critical, status, source, estimated_hours, created_by)
    values (v_demo, private.next_document_number(v_demo, 'work_order'), v_truck.id, 'Post-trip inspection defect — wipers (demo)', 'wipers: Driver-side blade streaking (demo)', 'inspection', 'normal', false, 'reported', 'inspection', 0.5, auth.uid())
    returning id into v_wo;
    insert into public.vehicle_inspections (company_id, truck_id, kind, inspected_on, items, defect_count, safety_defect, work_order_id, created_by)
    values (v_demo, v_truck.id, 'post_trip', v_day,
            (select jsonb_agg(jsonb_build_object('key', key, 'ok', key <> 'wipers', 'note', case when key = 'wipers' then 'Driver-side blade streaking (demo)' else '' end)) from private.inspection_items()),
            1, false, v_wo, auth.uid())
    on conflict do nothing;
    v_n := v_n + 1;
  end if;
  return v_n;
end;
$$;

revoke all on function public.inspection_submit(jsonb) from public, anon;
revoke all on function public.inspection_my_trucks() from public, anon;
revoke all on function public.inspection_missing_today() from public, anon;
revoke all on function public.demo_inspection_samples() from public, anon;
grant execute on function public.inspection_submit(jsonb) to authenticated;
grant execute on function public.inspection_my_trucks() to authenticated;
grant execute on function public.inspection_missing_today() to authenticated;
grant execute on function public.demo_inspection_samples() to authenticated;
