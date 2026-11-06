-- Company import for Top Line's real data (LR3, owner 2026-11-06: customers and job sites, trucks and trailers, drivers
-- and staff, rates and open orders). This step: job sites (matched to an existing customer by name), trailers, and
-- drivers' CDL (class, state, expiry) and medical card expiry, recorded as entered and unverified. Same staging, preview,
-- per-row decisions and all-or-nothing approval as before (20261120004600). Rollback:
-- supabase/rollbacks/20261120008300_import_sites_trailers_credentials.down.sql

alter table private.import_batches drop constraint if exists import_batches_entity_check;
alter table private.import_batches add constraint import_batches_entity_check
  check (entity in ('customers', 'materials', 'trucks', 'drivers', 'sites', 'trailers'));

create or replace function private.import_fields(p_entity text)
returns text[]
language sql
immutable
set search_path = ''
as $$
  select case p_entity
    when 'customers' then array['name', 'customer_type', 'email', 'phone', 'billing_line1', 'billing_line2', 'billing_city',
                                'billing_state', 'billing_postal_code', 'payment_terms', 'po_required', 'tax_exempt', 'notes']
    when 'materials' then array['name', 'code', 'description', 'default_unit_code', 'taxable_default']
    when 'trucks'    then array['unit_number', 'truck_type', 'make', 'model', 'model_year', 'vin', 'license_plate', 'plate_state', 'notes']
    when 'drivers'   then array['name', 'employee_number', 'phone', 'hire_date', 'notes', 'cdl_class', 'cdl_state', 'cdl_expires_on', 'medical_expires_on']
    when 'sites'     then array['customer_name', 'label', 'line1', 'line2', 'city', 'state', 'postal_code', 'directions']
    when 'trailers'  then array['unit_number', 'trailer_type', 'make', 'model', 'model_year', 'vin', 'license_plate', 'plate_state', 'notes']
  end
$$;

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
  v_cnt    integer;
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
    if p_entity = 'sites' then
      if coalesce(v_data ->> 'customer_name', '') = '' then
        v_msgs := array_append(v_msgs, 'Customer is required (import customers first).');
      else
        select count(*) into v_cnt from public.customers c where c.company_id = p_company and lower(trim(c.name)) = lower(v_data ->> 'customer_name');
        if v_cnt = 0 then v_msgs := array_append(v_msgs, 'No customer with this name. Import or add the customer first.');
        elsif v_cnt > 1 then v_msgs := array_append(v_msgs, 'More than one customer has this name. Rename one first.');
        end if;
      end if;
      if coalesce(v_data ->> 'line1', '') = '' then v_msgs := array_append(v_msgs, 'Street address is required.'); end if;
    end if;
    if p_entity = 'trailers' then
      if coalesce(v_data ->> 'unit_number', '') = '' then v_msgs := array_append(v_msgs, 'Unit number is required.'); end if;
      if coalesce(v_data ->> 'trailer_type', '') not in ('end_dump', 'belly_dump', 'side_dump', 'live_floor', 'pup', 'dry_van', 'reefer', 'flatbed', 'step_deck', 'lowboy', 'other') then
        v_msgs := array_append(v_msgs, 'Trailer type is not one of the allowed values.');
      end if;
    end if;
    if p_entity = 'drivers' then
      if v_data ? 'cdl_class' and v_data ->> 'cdl_class' not in ('A', 'B', 'C') then v_msgs := array_append(v_msgs, 'CDL class must be A, B or C.'); end if;
      if v_data ? 'cdl_expires_on' and not v_data ? 'cdl_class' then v_msgs := array_append(v_msgs, 'A CDL expiry needs the CDL class.'); end if;
      if v_data ? 'cdl_state' and v_data ->> 'cdl_state' !~ '^[A-Z]{2}$' then v_msgs := array_append(v_msgs, 'CDL state must be two letters, like IN.'); end if;
      if v_data ? 'cdl_expires_on' and not pg_input_is_valid(v_data ->> 'cdl_expires_on', 'date') then v_msgs := array_append(v_msgs, 'CDL expiry is not a date.'); end if;
      if v_data ? 'medical_expires_on' and not pg_input_is_valid(v_data ->> 'medical_expires_on', 'date') then v_msgs := array_append(v_msgs, 'Medical card expiry is not a date.'); end if;
    end if;
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
    elsif p_entity = 'sites' then
      v_key := 's:' || lower(coalesce(v_data ->> 'customer_name', '')) || '|' || lower(coalesce(v_data ->> 'line1', ''));
      if exists (select 1 from public.customer_sites s join public.customers c on c.id = s.customer_id
                 where s.company_id = p_company and lower(trim(c.name)) = lower(v_data ->> 'customer_name') and lower(trim(s.line1)) = lower(v_data ->> 'line1')) then
        v_msgs := array_append(v_msgs, 'A job site with this address already exists for this customer.');
      end if;
    elsif p_entity = 'trailers' then
      v_key := 'u:' || lower(v_data ->> 'unit_number');
      if exists (select 1 from public.trailers t where t.company_id = p_company and lower(trim(t.unit_number)) = lower(v_data ->> 'unit_number')) then
        v_msgs := array_append(v_msgs, 'A trailer with this unit number already exists.');
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

create or replace function private.import_approve_core(p_batch uuid, p_actor uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := p_actor;
  b    private.import_batches%rowtype;
  r    private.import_rows%rowtype;
  d    jsonb;
  v_id uuid;
  v_n  integer := 0;
begin
  select * into b from private.import_batches where id = p_batch for update;
  if not found or b.status <> 'review' then raise exception 'Only a batch in review can be approved.' using errcode = '22023'; end if;
  if not exists (select 1 from public.companies where id = b.company_id and active) then
    raise exception 'The company is no longer active.' using errcode = '22023';
  end if;
  perform set_config('tlt.platform_write', 'on', true);
  for r in select * from private.import_rows where batch_id = p_batch and decision = 'import' order by row_number loop
    d := r.data;
    begin
      if b.entity = 'customers' then
        insert into public.customers (company_id, name, customer_type, email, phone, billing_line1, billing_line2, billing_city,
                                      billing_state, billing_postal_code, payment_terms, po_required, tax_exempt, notes)
        values (b.company_id, d ->> 'name', coalesce(d ->> 'customer_type', 'commercial')::public.customer_type,
                coalesce(d ->> 'email', ''), coalesce(d ->> 'phone', ''), coalesce(d ->> 'billing_line1', ''), coalesce(d ->> 'billing_line2', ''),
                coalesce(d ->> 'billing_city', ''), coalesce(d ->> 'billing_state', ''), coalesce(d ->> 'billing_postal_code', ''),
                coalesce(d ->> 'payment_terms', ''), coalesce((d ->> 'po_required')::boolean, false), coalesce((d ->> 'tax_exempt')::boolean, false),
                coalesce(d ->> 'notes', ''))
        returning id into v_id;
      elsif b.entity = 'materials' then
        insert into public.materials (company_id, name, code, description, default_unit_code, taxable_default)
        values (b.company_id, d ->> 'name', d ->> 'code', coalesce(d ->> 'description', ''), d ->> 'default_unit_code',
                coalesce((d ->> 'taxable_default')::boolean, true))
        returning id into v_id;
      elsif b.entity = 'trucks' then
        insert into public.trucks (company_id, unit_number, truck_type, make, model, model_year, vin, license_plate, plate_state, notes)
        values (b.company_id, d ->> 'unit_number', (d ->> 'truck_type')::public.truck_type, coalesce(d ->> 'make', ''), coalesce(d ->> 'model', ''),
                (d ->> 'model_year')::integer, coalesce(d ->> 'vin', ''), coalesce(d ->> 'license_plate', ''), coalesce(d ->> 'plate_state', ''),
                coalesce(d ->> 'notes', ''))
        returning id into v_id;
      elsif b.entity = 'sites' then
        insert into public.customer_sites (company_id, customer_id, label, line1, line2, city, state, postal_code, directions)
        values (b.company_id,
                (select c.id from public.customers c where c.company_id = b.company_id and lower(trim(c.name)) = lower(d ->> 'customer_name')),
                coalesce(nullif(d ->> 'label', ''), d ->> 'line1'), d ->> 'line1', coalesce(d ->> 'line2', ''), coalesce(d ->> 'city', ''),
                coalesce(nullif(d ->> 'state', ''), 'IN'), coalesce(d ->> 'postal_code', ''), coalesce(d ->> 'directions', ''))
        returning id into v_id;
      elsif b.entity = 'trailers' then
        insert into public.trailers (company_id, unit_number, trailer_type, make, model, model_year, vin, license_plate, plate_state, notes)
        values (b.company_id, d ->> 'unit_number', (d ->> 'trailer_type')::public.trailer_type, coalesce(d ->> 'make', ''), coalesce(d ->> 'model', ''),
                (d ->> 'model_year')::integer, coalesce(d ->> 'vin', ''), coalesce(d ->> 'license_plate', ''), coalesce(d ->> 'plate_state', ''),
                coalesce(d ->> 'notes', ''))
        returning id into v_id;
      else
        insert into public.drivers (company_id, name, employee_number, phone, hire_date, notes)
        values (b.company_id, d ->> 'name', coalesce(d ->> 'employee_number', ''), coalesce(d ->> 'phone', ''), (d ->> 'hire_date')::date,
                coalesce(d ->> 'notes', ''))
        returning id into v_id;
        -- Credentials from the file are recorded as entered and left unverified (a person verifies them on the driver).
        if d ? 'cdl_class' then
          insert into public.driver_qualifications (company_id, driver_id, kind, cdl_class, issuing_state, expires_on, notes)
          values (b.company_id, v_id, 'cdl', (d ->> 'cdl_class')::public.cdl_class, coalesce(d ->> 'cdl_state', ''), (d ->> 'cdl_expires_on')::date, 'Imported');
        end if;
        if d ? 'medical_expires_on' then
          insert into public.driver_qualifications (company_id, driver_id, kind, expires_on, notes)
          values (b.company_id, v_id, 'medical_card', (d ->> 'medical_expires_on')::date, 'Imported');
        end if;
      end if;
    exception when unique_violation or invalid_text_representation or invalid_datetime_format or datetime_field_overflow
                   or numeric_value_out_of_range or check_violation or not_null_violation or foreign_key_violation then
      raise exception 'Row % could not be imported (%). Nothing was imported.', r.row_number, sqlerrm using errcode = '22023';
    end;
    update private.import_rows set target_id = v_id, outcome = 'created' where id = r.id;
    v_n := v_n + 1;
  end loop;
  perform set_config('tlt.platform_write', 'off', true);
  update private.import_batches set status = 'approved', decided_by = v_me, decided_at = now(),
         result = jsonb_build_object('created', v_n)
  where id = p_batch;
  return jsonb_build_object('created', v_n);
end;
$$;

-- Undo (records become inactive, never deleted) covers job sites and trailers too.
create or replace function public.company_import_undo(p_batch uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  b private.import_batches%rowtype := private.company_import_batch_for(p_batch);
  r private.import_rows%rowtype;
  v_n integer := 0;
begin
  if b.status <> 'approved' then
    raise exception 'Only an approved import can be undone.' using errcode = '22023';
  end if;
  if trim(coalesce(p_reason, '')) = '' then
    raise exception 'Give a reason for undoing the import.' using errcode = '22023';
  end if;
  for r in select * from private.import_rows where batch_id = b.id and outcome = 'created' and target_id is not null loop
    if b.entity = 'customers' then update public.customers set active = false where id = r.target_id and company_id = b.company_id;
    elsif b.entity = 'materials' then update public.materials set active = false where id = r.target_id and company_id = b.company_id;
    elsif b.entity = 'trucks' then update public.trucks set active = false where id = r.target_id and company_id = b.company_id;
    elsif b.entity = 'sites' then update public.customer_sites set active = false where id = r.target_id and company_id = b.company_id;
    elsif b.entity = 'trailers' then update public.trailers set active = false where id = r.target_id and company_id = b.company_id;
    else update public.drivers set active = false where id = r.target_id and company_id = b.company_id;
    end if;
    update private.import_rows set outcome = 'deactivated' where id = r.id;
    v_n := v_n + 1;
  end loop;
  update private.import_batches set status = 'deactivated', reverted_by = auth.uid(), reverted_at = now(), revert_reason = trim(p_reason),
         result = result || jsonb_build_object('deactivated', v_n)
   where id = b.id;
  perform private.log_event('import.undone', 'import', b.id, format('Spreadsheet import undone: %s %s made inactive', v_n, b.entity),
    jsonb_build_object('deactivated', v_n, 'reason', trim(p_reason)));
  return jsonb_build_object('deactivated', v_n);
end;
$$;
