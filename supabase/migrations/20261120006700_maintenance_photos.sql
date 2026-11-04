-- Photos on work orders and inspection defects, and dump-body items on dump trucks' inspections (UX9, owner 2026-11-04).
--
--   * public.work_order_photos            photos in the private maintenance-photos bucket (the server's service role
--                                          stores and signs; nobody reads the bucket directly)
--   * public.work_order_photo_begin(...)  the shop (maintenance.manage) adds a photo to an open work order
--   * public.inspection_photo_begin(...)  the driver who just reported a defect adds a photo to the work order their
--                                          inspection opened (same day, while it is open)
--   * public.work_order_photo_path(...)   the file path for people who may see it; the app signs a one-minute link
--   * private.inspection_items_for(truck) the DVIR items, plus five dump-body items when the truck is a dump truck
--   * public.inspection_submit / inspection_my_trucks  replaced to use those items (same signatures and results; the
--                                          truck list gains a "dump" flag)
--
-- The dump-body items are not marked safety items: a defect opens a work order for the shop but does not take the
-- truck out of service by itself (only the standard DVIR safety items do, as before). Additive and reversible:
-- supabase/rollbacks/20261120006700_maintenance_photos.down.sql.

create table public.work_order_photos (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.companies (id),
  work_order_id  uuid not null,
  object_path    text not null unique check (object_path ~ '^[0-9a-f-]{36}/maintenance/[0-9a-f-]{36}\.(jpg|png|webp)$'),
  mime_type      text not null check (mime_type in ('image/jpeg', 'image/png', 'image/webp')),
  size_bytes     integer not null check (size_bytes between 1 and 5242880),
  uploaded_by    uuid references auth.users (id) on delete set null,
  created_at     timestamptz not null default now(),
  foreign key (company_id, work_order_id) references public.work_orders (company_id, id) on delete cascade
);
create index work_order_photos_idx on public.work_order_photos (work_order_id, created_at);

alter table public.work_order_photos enable row level security;
create policy work_order_photos_read on public.work_order_photos for select to authenticated
  using (company_id = (select private.current_company_id()) and (select private.has_permission('maintenance.view')));
revoke all on public.work_order_photos from anon;
grant select on public.work_order_photos to authenticated;

-- Shared: check the file, keep at most 8 per work order, reserve the path.
create or replace function private.wo_photo_reserve(p_wo public.work_orders, p_mime text, p_size integer)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_path text;
begin
  if p_mime not in ('image/jpeg', 'image/png', 'image/webp') or p_size is null or p_size < 1 or p_size > 5242880 then
    raise exception 'Photos must be JPEG, PNG or WebP and at most 5 MB.' using errcode = '22023';
  end if;
  if (select count(*) from public.work_order_photos where work_order_id = p_wo.id) >= 8 then
    raise exception 'At most 8 photos per work order.' using errcode = '22023';
  end if;
  v_path := format('%s/maintenance/%s.%s', p_wo.company_id, gen_random_uuid(), case p_mime when 'image/png' then 'png' when 'image/webp' then 'webp' else 'jpg' end);
  insert into public.work_order_photos (company_id, work_order_id, object_path, mime_type, size_bytes, uploaded_by)
  values (p_wo.company_id, p_wo.id, v_path, p_mime, p_size, auth.uid());
  perform private.wo_event(p_wo.company_id, p_wo.id, 'updated', null, null, 'Photo added');
  return v_path;
end;
$$;
revoke all on function private.wo_photo_reserve(public.work_orders, text, integer) from public, anon, authenticated;

-- The shop adds a photo to an open work order (maintenance.manage, through the crew rule).
create or replace function public.work_order_photo_begin(p_wo uuid, p_mime text, p_size integer)
returns text
language plpgsql
security definer
set search_path = ''
as $$
begin
  return private.wo_photo_reserve(private.wo_for_crew(p_wo), p_mime, p_size);
end;
$$;

-- The driver who recorded an inspection adds a photo of the defect to the work order it opened (that day, while the
-- work order is open). Anyone else needs maintenance.manage.
create or replace function public.inspection_photo_begin(p_inspection uuid, p_mime text, p_size integer)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v_insp public.vehicle_inspections%rowtype;
  v_wo public.work_orders%rowtype;
begin
  select * into v_insp from public.vehicle_inspections where id = p_inspection and company_id = v_company;
  if not found or v_insp.work_order_id is null
     or not (private.has_permission('maintenance.manage')
             or (v_insp.created_by = auth.uid() and v_insp.inspected_on = private.company_today(v_company))) then
    raise exception 'Inspection not found.' using errcode = 'P0002';
  end if;
  select * into v_wo from public.work_orders where id = v_insp.work_order_id and company_id = v_company for update;
  if not found or v_wo.status in ('closed', 'canceled') then
    raise exception 'The work order for this defect is closed.' using errcode = 'P0001';
  end if;
  return private.wo_photo_reserve(v_wo, p_mime, p_size);
end;
$$;

-- The file path of a photo for people who may see it (maintenance.view, or whoever added it).
create or replace function public.work_order_photo_path(p_photo uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select p.object_path from public.work_order_photos p
   where p.id = p_photo and p.company_id = private.current_company_id()
     and (private.has_permission('maintenance.view') or p.uploaded_by = auth.uid());
$$;

revoke all on function public.work_order_photo_begin(uuid, text, integer), public.inspection_photo_begin(uuid, text, integer),
  public.work_order_photo_path(uuid) from public, anon;
grant execute on function public.work_order_photo_begin(uuid, text, integer), public.inspection_photo_begin(uuid, text, integer),
  public.work_order_photo_path(uuid) to authenticated;

-- The private bucket (no policies: only the server's service role reads and writes it).
do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('maintenance-photos', 'maintenance-photos', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
    on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
  end if;
end;
$$;

-- The items a truck's inspection covers: the DVIR items for every truck, plus the dump body on dump trucks.
create or replace function private.inspection_items_for(p_truck uuid)
returns table (key text, safety boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select i.key, i.safety from private.inspection_items() i
  union all
  select d.key, d.safety
    from (values ('air_lines', false), ('hoist_body', false), ('pto', false), ('tarp', false), ('tailgate', false)) d (key, safety)
   where exists (select 1 from public.trucks t where t.id = p_truck and t.truck_type::text like '%\_dump' escape '\');
$$;
revoke all on function private.inspection_items_for(uuid) from public, anon, authenticated;

-- Same as 20261120006100 (offline saves dated today or yesterday), with the items of this truck
-- (private.inspection_items_for) instead of the fixed list.
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
  select coalesce(jsonb_agg(jsonb_build_object('key', e ->> 'key', 'note', left(trim(e ->> 'note'), 300), 'safety', i.safety)), '[]'::jsonb),
         coalesce(bool_or(i.safety), false)
    into v_defects, v_safety
  from jsonb_array_elements(v_items) e join private.inspection_items_for(v_truck) i on i.key = e ->> 'key'
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

-- Same as 20261120006000, plus whether the truck is a dump truck (its inspection then includes the dump body).
create or replace function public.inspection_my_trucks()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with d as (select private.company_today(private.current_company_id()) as day where private.current_company_id() is not null)
  select coalesce(jsonb_agg(jsonb_build_object('id', t ->> 'id', 'unit', t ->> 'unit',
           'dump', exists (select 1 from public.trucks k where k.id = (t ->> 'id')::uuid and k.truck_type::text like '%\_dump' escape '\'),
           'pre_trip', exists (select 1 from public.vehicle_inspections v where v.truck_id = (t ->> 'id')::uuid and v.inspected_on = d.day and v.kind = 'pre_trip'),
           'post_trip', exists (select 1 from public.vehicle_inspections v where v.truck_id = (t ->> 'id')::uuid and v.inspected_on = d.day and v.kind = 'post_trip'))), '[]'::jsonb)
  from d, jsonb_array_elements(public.fuel_my_trucks(d.day)) t;
$$;
