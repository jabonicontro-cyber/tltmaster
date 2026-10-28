-- =============================================================================
-- Company self-import (B106, owner 2026-10-28): a company's owner or administrator (settings.manage) imports their own
-- customers, materials, trucks and drivers from a spreadsheet, through the same pipeline the platform team uses
-- (20261024000100): stage with validation and duplicate checks, review row by row, approve all or nothing.
--
-- One importer: the staging and approval bodies move unchanged into private.import_stage_core and
-- private.import_approve_core; the platform functions keep their names, checks and platform log and call them; the
-- company functions below call the same cores for the caller's own company only and write the company audit log.
-- Undo for a company never deletes: it makes the records the batch created inactive (the platform team's revert still
-- removes untouched records). Demo companies may import too; nothing leaves Taviron.
-- Reversible: supabase/rollbacks/20261120004600_company_import.down.sql
-- =============================================================================

alter table private.import_batches drop constraint if exists import_batches_status_check;
alter table private.import_batches add constraint import_batches_status_check check (status in ('review', 'approved', 'reverted', 'discarded', 'deactivated'));
alter table private.import_rows drop constraint if exists import_rows_outcome_check;
alter table private.import_rows add constraint import_rows_outcome_check check (outcome in ('', 'created', 'removed', 'kept_changed', 'kept_in_use', 'deactivated'));
alter table private.import_batches add column if not exists source text not null default 'platform' check (source in ('platform', 'company'));

-- Shared cores (moved unchanged from the platform functions of 20261024000100).
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
      if coalesce(v_data ->> 'truck_type', '') not in ('single_axle_dump', 'tandem_axle_dump', 'tri_axle_dump', 'quad_axle_dump', 'tractor', 'other') then
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
      else
        insert into public.drivers (company_id, name, employee_number, phone, hire_date, notes)
        values (b.company_id, d ->> 'name', coalesce(d ->> 'employee_number', ''), coalesce(d ->> 'phone', ''), (d ->> 'hire_date')::date,
                coalesce(d ->> 'notes', ''))
        returning id into v_id;
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


-- The platform functions: same names and checks as before, now calling the shared cores.
create or replace function public.platform_import_stage(p_company uuid, p_entity text, p_file_name text, p_mapping jsonb, p_rows jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me    uuid := private.require_platform_admin();
  v_batch uuid;
begin
  if not exists (select 1 from public.companies where id = p_company and active and not is_demo) then
    raise exception 'Company not found.' using errcode = 'P0002';
  end if;
  v_batch := private.import_stage_core(p_company, p_entity, p_file_name, p_mapping, p_rows, v_me);
  perform private.platform_log('import_staged', 'import', v_batch::text,
    format('Staged %s %s for review', jsonb_array_length(p_rows), p_entity),
    jsonb_build_object('company_id', p_company, 'file_name', left(coalesce(p_file_name, ''), 200)));
  return v_batch;
end;
$$;

create or replace function public.platform_import_approve(p_batch uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me  uuid := private.require_platform_admin();
  v_out jsonb := private.import_approve_core(p_batch, v_me);
  b     private.import_batches%rowtype;
begin
  select * into b from private.import_batches where id = p_batch;
  perform private.platform_log('import_approved', 'import', p_batch::text, format('Approved: created %s %s', v_out ->> 'created', b.entity),
                               jsonb_build_object('company_id', b.company_id, 'created', (v_out ->> 'created')::int));
  return v_out;
end;
$$;

-- A batch of the caller's own company, for its administrators (internal).
create or replace function private.company_import_batch_for(p_batch uuid)
returns private.import_batches
language plpgsql
security definer
set search_path = ''
as $$
declare
  b private.import_batches%rowtype;
begin
  perform private.require_permission('settings.manage');
  select * into b from private.import_batches where id = p_batch and company_id = private.require_company() for update;
  if not found then
    raise exception 'Import not found.' using errcode = 'P0002';
  end if;
  return b;
end;
$$;

create or replace function public.company_import_stage(p_entity text, p_file_name text, p_mapping jsonb, p_rows jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v_batch uuid;
begin
  perform private.require_permission('settings.manage');
  v_batch := private.import_stage_core(v_company, p_entity, p_file_name, p_mapping, p_rows, auth.uid());
  update private.import_batches set source = 'company' where id = v_batch;
  perform private.log_event('import.staged', 'import', v_batch, format('Spreadsheet staged for review: %s %s', jsonb_array_length(p_rows), p_entity),
    jsonb_build_object('entity', p_entity, 'file_name', left(coalesce(p_file_name, ''), 200)));
  return v_batch;
end;
$$;

create or replace function public.company_import_batches()
returns table (id uuid, entity text, status text, file_name text, created_at timestamptz, created_by text,
               rows integer, valid integer, duplicates integer, errors integer, to_import integer, result jsonb)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
begin
  perform private.require_permission('settings.manage');
  return query
    select b.id, b.entity, b.status, b.file_name, b.created_at, coalesce(nullif(p.full_name, ''), p.email),
           (select count(*)::int from private.import_rows r where r.batch_id = b.id),
           (select count(*)::int from private.import_rows r where r.batch_id = b.id and r.status = 'valid'),
           (select count(*)::int from private.import_rows r where r.batch_id = b.id and r.status = 'duplicate'),
           (select count(*)::int from private.import_rows r where r.batch_id = b.id and r.status = 'error'),
           (select count(*)::int from private.import_rows r where r.batch_id = b.id and r.decision = 'import'),
           b.result
      from private.import_batches b left join public.profiles p on p.id = b.created_by
     where b.company_id = v_company
     order by b.created_at desc
     limit 50;
end;
$$;

create or replace function public.company_import_batch(p_batch uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v jsonb;
begin
  perform private.require_permission('settings.manage');
  select to_jsonb(b) into v from private.import_batches b where b.id = p_batch and b.company_id = private.require_company();
  if v is null then
    return null;
  end if;
  return v || jsonb_build_object('rows', coalesce((
    select jsonb_agg(jsonb_build_object('id', r.id, 'row', r.row_number, 'data', r.data, 'status', r.status, 'messages', r.messages,
                                        'can_override', r.can_override, 'decision', r.decision, 'outcome', r.outcome) order by r.row_number)
      from private.import_rows r where r.batch_id = p_batch), '[]'::jsonb));
end;
$$;

create or replace function public.company_import_decide(p_row uuid, p_decision text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v private.import_rows%rowtype;
begin
  perform private.require_permission('settings.manage');
  select r.* into v from private.import_rows r join private.import_batches b on b.id = r.batch_id
   where r.id = p_row and b.company_id = private.require_company() and b.status = 'review' for update of r;
  if not found then
    raise exception 'This row can no longer be changed.' using errcode = 'P0002';
  end if;
  if p_decision not in ('import', 'skip') then
    raise exception 'Unknown decision.' using errcode = '22023';
  end if;
  if p_decision = 'import' and not (v.status = 'valid' or (v.status = 'duplicate' and v.can_override)) then
    raise exception 'This row cannot be imported: fix it in the spreadsheet and upload again.' using errcode = '22023';
  end if;
  update private.import_rows set decision = p_decision where id = p_row;
end;
$$;

create or replace function public.company_import_discard(p_batch uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  b private.import_batches%rowtype := private.company_import_batch_for(p_batch);
begin
  if b.status <> 'review' then
    raise exception 'Only an import in review can be discarded.' using errcode = '22023';
  end if;
  update private.import_batches set status = 'discarded', decided_by = auth.uid(), decided_at = now() where id = b.id;
  perform private.log_event('import.discarded', 'import', b.id, 'Spreadsheet import discarded; nothing was created');
end;
$$;

create or replace function public.company_import_approve(p_batch uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  b private.import_batches%rowtype := private.company_import_batch_for(p_batch);
  v_out jsonb;
begin
  v_out := private.import_approve_core(b.id, auth.uid());
  perform private.log_event('import.approved', 'import', b.id, format('Spreadsheet import approved: created %s %s', v_out ->> 'created', b.entity), v_out);
  return v_out;
end;
$$;

-- Undo for a company: every record the batch created becomes inactive (kept, never deleted), with the reason.
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

-- Demo sample (B106): one customer spreadsheet waiting for review in a demo company, so every demo shows the real
-- review with a ready row, a possible duplicate and a row that needs fixing. Nothing is created until someone approves.
create or replace function public.demo_import_samples()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_demo uuid := private.demo_owner_company();
  v_existing text;
  v_batch uuid;
begin
  if v_demo is null then
    raise exception 'Demo samples are only added to a demo company, by its owner.' using errcode = '42501';
  end if;
  if exists (select 1 from private.import_batches where company_id = v_demo and source = 'company') then
    return 0;
  end if;
  select name into v_existing from public.customers where company_id = v_demo and active order by created_at limit 1;
  v_batch := private.import_stage_core(v_demo, 'customers', 'new-customers-sample.csv', '{"Customer": "name", "Email": "email", "Phone": "phone"}'::jsonb,
    jsonb_build_array(
      jsonb_build_object('row', 2, 'data', jsonb_build_object('name', 'Cedar Ridge Landscaping (demo)', 'email', 'office@cedar-ridge.example', 'phone', '555-0142')),
      jsonb_build_object('row', 3, 'data', jsonb_build_object('name', 'Quarry Lane Builders (demo)', 'email', 'ap@quarry-lane.example')),
      jsonb_build_object('row', 4, 'data', jsonb_build_object('name', coalesce(v_existing, 'Quarry Lane Builders (demo)'))),
      jsonb_build_object('row', 5, 'data', jsonb_build_object('name', '', 'email', 'not-an-email'))),
    auth.uid());
  update private.import_batches set source = 'company' where id = v_batch;
  return 1;
end;
$$;

revoke all on function private.import_stage_core(uuid, text, text, jsonb, jsonb, uuid), private.import_approve_core(uuid, uuid),
  private.company_import_batch_for(uuid) from public, anon, authenticated;
revoke all on function public.company_import_stage(text, text, jsonb, jsonb), public.company_import_batches(), public.company_import_batch(uuid),
  public.company_import_decide(uuid, text), public.company_import_discard(uuid), public.company_import_approve(uuid), public.company_import_undo(uuid, text),
  public.demo_import_samples() from public, anon;
grant execute on function public.company_import_stage(text, text, jsonb, jsonb), public.company_import_batches(), public.company_import_batch(uuid),
  public.company_import_decide(uuid, text), public.company_import_discard(uuid), public.company_import_approve(uuid), public.company_import_undo(uuid, text),
  public.demo_import_samples() to authenticated;
