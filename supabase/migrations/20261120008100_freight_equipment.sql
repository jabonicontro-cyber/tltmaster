-- Freight equipment and places (MK4, owner 2026-11-05: "make sure the freight mode is completely tailored to just
-- freight"). Additive only: general freight carriers can record straight trucks, dry vans, reefers and step decks,
-- and save shippers, receivers and warehouses as places. Aggregate companies keep their lists (the app shows each
-- company the types for what it hauls). Company imports accept the new truck type.
-- Rollback: supabase/rollbacks/20261120008100_freight_equipment.down.sql (enum values stay; rows move to 'other').

alter type public.truck_type add value if not exists 'straight_truck';
alter type public.trailer_type add value if not exists 'dry_van';
alter type public.trailer_type add value if not exists 'reefer';
alter type public.trailer_type add value if not exists 'step_deck';

alter table public.company_locations drop constraint if exists company_locations_kind_check;
alter table public.company_locations add constraint company_locations_kind_check
  check (kind in ('yard', 'terminal', 'quarry', 'plant', 'pickup', 'shipper', 'receiver', 'warehouse', 'other'));

-- Company and platform imports: the same function as 20261120004600, with 'straight_truck' accepted.
create or replace function private.import_stage_core(p_company uuid, p_entity text, p_file_name text, p_mapping jsonb, p_rows jsonb, p_actor uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me     uuid := p_actor;
  v_batch  uuid;
  v_fields text[] := private.import_fields(p_entity);
  r        jsonb;
  v_data   jsonb;
  v_msgs   text[];
  v_status text;
  v_over   boolean;
  v_key    text;
  v_key2   text;
  v_seen   jsonb := '{}'::jsonb;
  v_n      integer := 0;
begin
  if v_fields is null then raise exception 'Unknown import type.' using errcode = '22023'; end if;
  if not exists (select 1 from public.companies where id = p_company and active) then
    raise exception 'Company not found.' using errcode = 'P0002';
  end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'The file has no rows to import.' using errcode = '22023';
  end if;
  if jsonb_array_length(p_rows) > 2000 then
    raise exception 'Import at most 2,000 rows at a time.' using errcode = '22023';
  end if;

  insert into private.import_batches (company_id, entity, file_name, mapping, created_by)
  values (p_company, p_entity, left(coalesce(p_file_name, ''), 200), coalesce(p_mapping, '{}'::jsonb), v_me)
  returning id into v_batch;

  for r in select * from jsonb_array_elements(p_rows) loop
    v_n := v_n + 1;
    -- Keep only known fields, as trimmed text.
    select coalesce(jsonb_object_agg(k, left(trim(r -> 'data' ->> k), 2000)), '{}'::jsonb) into v_data
    from unnest(v_fields) k where nullif(trim(r -> 'data' ->> k), '') is not null;
    select coalesce(array_agg(left(e, 300)), '{}') into v_msgs from jsonb_array_elements_text(coalesce(r -> 'errors', '[]'::jsonb)) e;
    v_over := false;
    v_key := null;
    v_key2 := null;

    -- Required fields and allowed values (again, at the database).
    if p_entity in ('customers', 'materials', 'drivers') and coalesce(v_data ->> 'name', '') = '' then
      v_msgs := array_append(v_msgs, 'Name is required.');
    end if;
    if p_entity = 'customers' and coalesce(v_data ->> 'customer_type', 'commercial') not in ('commercial', 'residential') then
      v_msgs := array_append(v_msgs, 'Customer type must be commercial or residential.');
    end if;
    if p_entity = 'materials' and not exists (select 1 from public.units_of_measure u where u.company_id = p_company and u.code = v_data ->> 'default_unit_code') then
      v_msgs := array_append(v_msgs, 'Unit must be one of the company''s units (ton, load, cu_yd, hour, mile, day, each).');
    end if;
    if p_entity = 'trucks' then
      if coalesce(v_data ->> 'unit_number', '') = '' then v_msgs := array_append(v_msgs, 'Unit number is required.'); end if;
      if coalesce(v_data ->> 'truck_type', '') not in ('single_axle_dump', 'tandem_axle_dump', 'tri_axle_dump', 'quad_axle_dump', 'tractor', 'straight_truck', 'other') then
        v_msgs := array_append(v_msgs, 'Truck type is not one of the allowed values.');
      end if;
    end if;

    -- Duplicates: against existing records, then within the file.
    if p_entity = 'customers' then
      v_key := 'n:' || lower(v_data ->> 'name');
      v_key2 := case when v_data ? 'email' then 'e:' || lower(v_data ->> 'email') end;
      if exists (select 1 from public.customers c where c.company_id = p_company
                 and (lower(trim(c.name)) = lower(v_data ->> 'name') or (v_data ? 'email' and lower(c.email) = lower(v_data ->> 'email')))) then
        v_msgs := array_append(v_msgs, 'A customer with this name or email already exists.');
        v_over := true;
      end if;
    elsif p_entity = 'materials' then
      v_key := 'n:' || lower(v_data ->> 'name');
      v_key2 := case when v_data ? 'code' then 'c:' || upper(v_data ->> 'code') end;
      if exists (select 1 from public.materials m where m.company_id = p_company
                 and (lower(m.name) = lower(v_data ->> 'name') or (v_data ? 'code' and upper(m.code) = upper(v_data ->> 'code')))) then
        v_msgs := array_append(v_msgs, 'A material with this name or code already exists.');
      end if;
    elsif p_entity = 'trucks' then
      v_key := 'u:' || lower(v_data ->> 'unit_number');
      if exists (select 1 from public.trucks t where t.company_id = p_company and lower(trim(t.unit_number)) = lower(v_data ->> 'unit_number')) then
        v_msgs := array_append(v_msgs, 'A truck with this unit number already exists.');
      end if;
    elsif p_entity = 'drivers' then
      if v_data ? 'employee_number' then
        v_key := 'e:' || lower(v_data ->> 'employee_number');
        if exists (select 1 from public.drivers d where d.company_id = p_company and lower(trim(d.employee_number)) = lower(v_data ->> 'employee_number')) then
          v_msgs := array_append(v_msgs, 'A driver with this employee number already exists.');
        end if;
      else
        v_key := 'n:' || lower(v_data ->> 'name');
        if exists (select 1 from public.drivers d where d.company_id = p_company and lower(trim(d.name)) = lower(v_data ->> 'name')) then
          v_msgs := array_append(v_msgs, 'A driver with this name already exists.');
          v_over := true;
        end if;
      end if;
    end if;
    if (v_key is not null and v_seen ? v_key) or (v_key2 is not null and v_seen ? v_key2) then
      v_msgs := array_append(v_msgs, ('Same as row ' || coalesce(v_seen ->> v_key, v_seen ->> v_key2) || ' of this file.'));
      v_over := false;
    end if;
    if v_key is not null and not v_seen ? v_key then v_seen := v_seen || jsonb_build_object(v_key, coalesce((r ->> 'row')::int, v_n)); end if;
    if v_key2 is not null and not v_seen ? v_key2 then v_seen := v_seen || jsonb_build_object(v_key2, coalesce((r ->> 'row')::int, v_n)); end if;

    -- A row with errors from validation is an error; a row whose only
    -- problem is a match is a duplicate (skipped unless the reviewer decides
    -- otherwise, where the database allows it).
    v_status := case
      when cardinality(v_msgs) = 0 then 'valid'
      when (select bool_and(m like 'A % already exists.' or m like 'Same as row %') from unnest(v_msgs) m) then 'duplicate'
      else 'error' end;
    insert into private.import_rows (batch_id, row_number, data, status, messages, can_override, decision)
    values (v_batch, coalesce((r ->> 'row')::int, v_n), v_data, v_status, v_msgs, v_status = 'duplicate' and v_over,
            case when v_status = 'valid' then 'import' else 'skip' end);
  end loop;

  return v_batch;
end;
$$;



-- Demo samples in a freight carrier's words (MK4): the sample rows other demo functions write (portal bookings, a shift
-- offer, safety findings) are reworded when the demo hauls general freight. Only the demo owner's own
-- demo company, only rows that still hold the exact sample text (a person's edits are kept), idempotent.
create or replace function public.demo_freight_sample_wording()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_demo uuid := private.demo_owner_company();
  v_n integer := 0;
  v_rows integer;
begin
  if v_demo is null then
    raise exception 'Demo samples are only changed in a demo company, by its owner.' using errcode = '42501';
  end if;
  if coalesce((select industry from public.company_settings where company_id = v_demo), 'aggregate') <> 'freight' then
    return 0;
  end if;
  update public.booking_requests b set material = x.to_text
    from (values ('Base rock for a driveway pour (demo)', 'Palletized building products, 22 pallets (demo)'),
                 ('Fill dirt (demo)', 'Paper rolls, full truckload (demo)')) as x(from_text, to_text)
    where b.company_id = v_demo and b.material = x.from_text;
  get diagnostics v_rows = row_count; v_n := v_n + v_rows;
  update public.shift_offers set note = 'Extra loads for a retailer''s holiday restock (demo). Nothing is sent outside Taviron.'
    where company_id = v_demo and note = 'Extra hauls for a large pour (demo). Nothing is sent outside Taviron.';
  get diagnostics v_rows = row_count; v_n := v_n + v_rows;
  update public.safety_incidents
    set findings = 'Gate opening is narrow for a tractor with a 53 ft trailer; the driver had not been to this receiver before. (Sample findings.)'
    where company_id = v_demo
      and findings = 'Gate opening is narrow for a tractor with an end-dump; the driver had not been to this site before. (Sample findings.)';
  get diagnostics v_rows = row_count; v_n := v_n + v_rows;
  return v_n;
end;
$$;

revoke all on function public.demo_freight_sample_wording() from public, anon;
grant execute on function public.demo_freight_sample_wording() to authenticated;

-- Support cases (B138 samples) are written in freight words for a freight demo: their messages are append-only, so
-- they are never reworded afterwards. Same function as 20261120006800 otherwise.
create or replace function public.demo_support_samples()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_demo uuid := private.demo_owner_company();
  v_customers uuid[];
  v_order uuid;
  v_id uuid;
  -- A demo that hauls general freight gets the same cases in a freight carrier's words (MK4, 20261120008100).
  v_freight boolean := coalesce((select industry from public.company_settings where company_id = private.demo_owner_company()), 'aggregate') = 'freight';
begin
  if v_demo is null then
    raise exception 'Demo samples are only added to a demo company, by its owner.' using errcode = '42501';
  end if;
  if exists (select 1 from public.support_settings where company_id = v_demo) then
    return 0;
  end if;
  insert into public.support_settings (company_id, first_reply_hours, updated_by) values (v_demo, 4, auth.uid());
  select array_agg(id order by name) into v_customers from (select id, name from public.customers where company_id = v_demo order by name limit 3) c;
  if coalesce(array_length(v_customers, 1), 0) = 0 then
    return 1;
  end if;
  select id into v_order from public.orders where company_id = v_demo and customer_id = v_customers[1] and status <> 'draft' order by created_at desc limit 1;

  insert into public.portal_support_requests (company_id, customer_id, opened_by_staff, order_id, subject, kind, status, created_at, updated_at)
  values (v_demo, v_customers[1], auth.uid(), v_order, case when v_freight then 'Load arrived after the receiving dock closed (demo)' else 'Load arrived after the crew left (demo)' end, 'delivery', 'open', now() - interval '6 hours', now() - interval '6 hours')
  returning id into v_id;
  insert into public.portal_messages (company_id, request_id, author_kind, author_id, body, created_at)
  values (v_demo, v_id, 'customer', null, case when v_freight then 'The second load came at 3:40 and our receiving dock closes at 3:00. Can we book earlier appointments? (demo)' else 'The second load came at 3:40 and our crew had already left. Can we plan tomorrow''s loads earlier? (demo)' end, now() - interval '6 hours');

  if array_length(v_customers, 1) >= 2 then
    insert into public.portal_support_requests (company_id, customer_id, opened_by_staff, subject, kind, status, assigned_to, first_reply_at, created_at, updated_at)
    values (v_demo, v_customers[2], auth.uid(), 'Question about last month''s fuel surcharge (demo)', 'billing', 'answered', auth.uid(), now() - interval '20 hours', now() - interval '1 day', now() - interval '20 hours')
    returning id into v_id;
    insert into public.portal_messages (company_id, request_id, author_kind, author_id, body, internal, created_at) values
      (v_demo, v_id, 'customer', null, 'Why is there a fuel surcharge on the October invoice? (demo)', false, now() - interval '1 day'),
      (v_demo, v_id, 'staff', auth.uid(), 'Check the surcharge table before replying; the rate changed on the 15th. (internal note, demo)', true, now() - interval '21 hours'),
      (v_demo, v_id, 'staff', auth.uid(), 'The surcharge follows the weekly diesel index on your contract. We attached the breakdown. (demo)', false, now() - interval '20 hours');
  end if;

  if array_length(v_customers, 1) >= 3 then
    insert into public.portal_support_requests (company_id, customer_id, opened_by_staff, subject, kind, status, assigned_to, first_reply_at, closed_at, created_at, updated_at)
    values (v_demo, v_customers[3], auth.uid(), case when v_freight then 'Two pallets short at delivery (demo)' else 'Received 57 instead of #53 stone (demo)' end, case when v_freight then 'delivery' else 'material' end, 'closed', auth.uid(), now() - interval '3 days', now() - interval '2 days', now() - interval '3 days', now() - interval '2 days')
    returning id into v_id;
    insert into public.portal_messages (company_id, request_id, author_kind, author_id, body, created_at) values
      (v_demo, v_id, 'customer', null, case when v_freight then 'The bill of lading says 26 pallets but we counted 24 at the dock. (demo)' else 'Ticket shows #53 but the pile looks like 57 stone. (demo)' end, now() - interval '3 days'),
      (v_demo, v_id, 'staff', auth.uid(), case when v_freight then 'The shipper found two pallets left on their dock. We delivered them this morning at no charge. (demo)' else 'You were right: the plant loaded the wrong bin. We swapped it this morning at no charge. (demo)' end, now() - interval '2 days');
  end if;
  return 4;
end;
$$;

