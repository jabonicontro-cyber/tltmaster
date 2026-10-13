-- =============================================================================
-- Expired vehicle documents policy (owner 2026-10-13; master plan §9 Q23).
--
-- * public.vehicle_document_rules — per company and document kind (registration,
--   insurance, inspection, permit): 'block' or 'warn'. Without a row the
--   documented recommendation applies: insurance and registration block,
--   inspection and permit warn. Lease, title and other documents are never
--   checked. Kinds and jurisdictions are not interchangeable: each kind has its
--   own rule, and nothing is inferred from one kind for another.
-- * public.vehicle_documents gains verified_at / verified_by: a person confirms
--   the record (date and document) is right. Only a VERIFIED expired document on
--   a 'block' kind blocks; an unverified one is a warning ("confirm it was
--   renewed"), so a typo never silently stops a truck. Changing the kind, dates
--   or archiving a document clears the verification.
-- * The latest non-archived document of each kind per vehicle decides; a renewed
--   document (later expiry) replaces an expired one.
-- * Enforced in the database: private.assignment_eligibility (Command Center and
--   dispatch checks) and private.check_assignment (assign_load), which names the
--   vehicle, kind, date and corrective action. Smart Dispatch and Plan the day
--   read the same rules through public.dispatch_document_issues (dispatch.view).
--
-- Replaces private.assignment_eligibility, private.eligibility_message and
-- private.check_assignment (current bodies plus the document checks).
-- Depends on 20261102000100 (vehicle documents) and 20261104000100 (time off).
-- Rollback: supabase/rollbacks/20261112000200_document_policy.down.sql
-- =============================================================================

create table public.vehicle_document_rules (
  company_id  uuid not null references public.companies (id),
  kind        text not null check (kind in ('registration', 'insurance', 'inspection', 'permit')),
  action      text not null check (action in ('block', 'warn')),
  updated_by  uuid references auth.users (id) on delete set null,
  updated_at  timestamptz not null default now(),
  primary key (company_id, kind)
);
create trigger a_company_guard before update of company_id on public.vehicle_document_rules
  for each row execute function private.forbid_company_change();
create trigger vehicle_document_rules_audit after insert or update or delete on public.vehicle_document_rules
  for each row execute function private.audit_row_change('vehicle_document_rule');
alter table public.vehicle_document_rules enable row level security;
create policy vehicle_document_rules_read on public.vehicle_document_rules for select to authenticated
  using (company_id = (select private.current_company_id()));
revoke all on public.vehicle_document_rules from anon, authenticated;
grant select on public.vehicle_document_rules to authenticated;
grant all on public.vehicle_document_rules to service_role;

alter table public.vehicle_documents add column verified_at timestamptz;
alter table public.vehicle_documents add column verified_by uuid references auth.users (id) on delete set null;

-- A changed kind, date or archive clears the verification (the person confirmed a different record).
create or replace function private.unverify_changed_document()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.kind is distinct from old.kind or new.expires_on is distinct from old.expires_on
     or new.issued_on is distinct from old.issued_on or (new.archived_at is not null and old.archived_at is null) then
    if new.verified_at is not distinct from old.verified_at then
      new.verified_at := null;
      new.verified_by := null;
    end if;
  end if;
  return new;
end;
$$;
create trigger vehicle_documents_unverify before update on public.vehicle_documents
  for each row execute function private.unverify_changed_document();

-- The rule for one kind (company row, else the documented default).
create or replace function private.document_rule(p_company uuid, p_kind text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select r.action from public.vehicle_document_rules r where r.company_id = p_company and r.kind = p_kind),
    case when p_kind in ('insurance', 'registration') then 'block' when p_kind in ('inspection', 'permit') then 'warn' end)
$$;

-- Latest non-archived document per kind for a truck or trailer that expired before p_on, with whether it blocks.
create or replace function private.expired_vehicle_documents(p_company uuid, p_truck uuid, p_trailer uuid, p_on date)
returns table (vehicle_kind text, vehicle_id uuid, unit_number text, kind text, expires_on date, verified boolean, action text, blocks boolean)
language sql
stable
security definer
set search_path = ''
as $$
  with latest as (
    select distinct on (coalesce(d.truck_id, d.trailer_id), d.kind)
      d.truck_id, d.trailer_id, d.kind, d.expires_on, d.verified_at
    from public.vehicle_documents d
    where d.company_id = p_company and d.archived_at is null and d.expires_on is not null
      and d.kind in ('registration', 'insurance', 'inspection', 'permit')
      and ((p_truck is not null and d.truck_id = p_truck) or (p_trailer is not null and d.trailer_id = p_trailer))
    order by coalesce(d.truck_id, d.trailer_id), d.kind, d.expires_on desc
  )
  select case when l.truck_id is not null then 'Truck' else 'Trailer' end,
         coalesce(l.truck_id, l.trailer_id),
         coalesce(t.unit_number, tr.unit_number),
         l.kind, l.expires_on, l.verified_at is not null,
         private.document_rule(p_company, l.kind),
         l.verified_at is not null and private.document_rule(p_company, l.kind) = 'block'
  from latest l
  left join public.trucks t on t.company_id = p_company and t.id = l.truck_id
  left join public.trailers tr on tr.company_id = p_company and tr.id = l.trailer_id
  where l.expires_on < p_on
$$;

/** Mark a document verified (fleet.edit): a person confirmed the record matches the paper document. */
create or replace function public.verify_vehicle_document(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
begin
  perform private.require_permission('fleet.edit');
  update public.vehicle_documents set verified_at = now(), verified_by = auth.uid()
  where id = p_id and company_id = v_company and archived_at is null;
  if not found then raise exception 'Document not found.' using errcode = 'P0002'; end if;
end;
$$;

/** Set the rule for one kind (settings.manage). */
create or replace function public.set_document_rule(p_kind text, p_action text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
begin
  perform private.require_permission('settings.manage');
  if p_kind not in ('registration', 'insurance', 'inspection', 'permit') then raise exception 'Unknown document kind.' using errcode = 'P0001'; end if;
  if p_action not in ('block', 'warn') then raise exception 'Choose block or warn.' using errcode = 'P0001'; end if;
  insert into public.vehicle_document_rules (company_id, kind, action, updated_by)
  values (v_company, p_kind, p_action, auth.uid())
  on conflict (company_id, kind) do update set action = excluded.action, updated_by = excluded.updated_by, updated_at = now();
end;
$$;

/** The effective rule per kind for the caller's company (company row or default). */
create or replace function public.document_rules()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_object_agg(k, private.document_rule(private.require_company(), k))
  from unnest(array['registration', 'insurance', 'inspection', 'permit']) k
$$;

/**
 * Expired documents of every truck and trailer for dispatch (dispatch.view): vehicle, kind, expiry, verified, rule.
 * No reference numbers, notes or other document details. Used by Smart Dispatch and Plan the day so proposals agree
 * with the database check.
 */
create or replace function public.dispatch_document_issues(p_on date)
returns table (truck_id uuid, trailer_id uuid, kind text, expires_on date, verified boolean, action text, blocks boolean)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
begin
  perform private.require_permission('dispatch.view');
  return query
    select case when x.vehicle_kind = 'Truck' then x.vehicle_id end, case when x.vehicle_kind = 'Trailer' then x.vehicle_id end,
           x.kind, x.expires_on, x.verified, x.action, x.blocks
    from (select distinct coalesce(d.truck_id, d.trailer_id) as vid, d.truck_id, d.trailer_id from public.vehicle_documents d
          where d.company_id = v_company and d.archived_at is null and d.expires_on is not null and d.expires_on < p_on) v
    cross join lateral private.expired_vehicle_documents(v_company, v.truck_id, v.trailer_id, p_on) x;
end;
$$;

revoke all on function private.document_rule(uuid, text), private.expired_vehicle_documents(uuid, uuid, uuid, date) from public, anon, authenticated;
revoke all on function public.verify_vehicle_document(uuid), public.set_document_rule(text, text), public.document_rules(), public.dispatch_document_issues(date) from public, anon;
grant execute on function public.verify_vehicle_document(uuid), public.set_document_rule(text, text), public.document_rules(), public.dispatch_document_issues(date) to authenticated;

CREATE OR REPLACE FUNCTION private.assignment_eligibility(p_company uuid, p_truck_id uuid, p_trailer_id uuid, p_driver_id uuid, p_on date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_company  uuid;
  v_on       date;
  v_truck    public.trucks%rowtype;
  v_trailer  public.trailers%rowtype;
  v_driver   public.drivers%rowtype;
  v_blockers text[] := '{}';
  v_warnings text[] := '{}';
  v_state    text;
  v_min      public.cdl_class;
  v_soon     date;
begin
  v_company := p_company;
  v_on := coalesce(p_on, private.business_today(v_company));
  v_soon := v_on + 30;

  if p_truck_id is null and p_trailer_id is null and p_driver_id is null then
    raise exception 'Choose a truck, a trailer or a driver.';
  end if;

  if p_truck_id is not null then
    select * into v_truck from public.trucks where id = p_truck_id and company_id = v_company;
    if not found then raise exception 'Truck not found.'; end if;
    if not v_truck.active then v_blockers := v_blockers || 'truck_inactive'::text; end if;
    if v_truck.service_status = 'out_of_service' then v_blockers := v_blockers || 'truck_out_of_service'::text; end if;
    if v_truck.weight_capacity is null and v_truck.volume_capacity is null then
      v_warnings := v_warnings || 'truck_capacity_unknown'::text;
    elsif v_truck.capacity_verified_at is null then
      v_warnings := v_warnings || 'truck_capacity_unverified'::text;
    end if;
  end if;

  if p_trailer_id is not null then
    select * into v_trailer from public.trailers where id = p_trailer_id and company_id = v_company;
    if not found then raise exception 'Trailer not found.'; end if;
    if not v_trailer.active then v_blockers := v_blockers || 'trailer_inactive'::text; end if;
    if v_trailer.service_status = 'out_of_service' then v_blockers := v_blockers || 'trailer_out_of_service'::text; end if;
    if v_trailer.weight_capacity is null and v_trailer.volume_capacity is null then
      v_warnings := v_warnings || 'trailer_capacity_unknown'::text;
    elsif v_trailer.capacity_verified_at is null then
      v_warnings := v_warnings || 'trailer_capacity_unverified'::text;
    end if;
    if p_truck_id is not null then
      if cardinality(v_trailer.compatible_truck_types) = 0 then
        v_warnings := v_warnings || 'trailer_compatibility_unknown'::text;
      elsif not (v_truck.truck_type = any (v_trailer.compatible_truck_types)) then
        v_blockers := v_blockers || 'trailer_incompatible'::text;
      end if;
    end if;
  end if;

  -- Unresolved driver reports about the equipment (N15).
  if p_truck_id is not null then
    if exists (select 1 from public.field_reports r where r.company_id = v_company and r.equipment = 'truck' and r.truck_id = p_truck_id
               and r.status in ('open', 'acknowledged') and r.kind in ('breakdown', 'inspection_issue')) then
      v_blockers := v_blockers || 'truck_safety_report_open'::text;
    elsif exists (select 1 from public.field_reports r where r.company_id = v_company and r.equipment = 'truck' and r.truck_id = p_truck_id
                  and r.status in ('open', 'acknowledged') and r.kind = 'equipment_issue') then
      v_warnings := v_warnings || 'truck_equipment_report_open'::text;
    end if;
  end if;
  if p_trailer_id is not null then
    if exists (select 1 from public.field_reports r where r.company_id = v_company and r.equipment = 'trailer' and r.trailer_id = p_trailer_id
               and r.status in ('open', 'acknowledged') and r.kind in ('breakdown', 'inspection_issue')) then
      v_blockers := v_blockers || 'trailer_safety_report_open'::text;
    elsif exists (select 1 from public.field_reports r where r.company_id = v_company and r.equipment = 'trailer' and r.trailer_id = p_trailer_id
                  and r.status in ('open', 'acknowledged') and r.kind = 'equipment_issue') then
      v_warnings := v_warnings || 'trailer_equipment_report_open'::text;
    end if;
  end if;

  -- Maintenance (20261101000100): open safety-critical work orders and shop
  -- visits on the load date. Defensive: a safety-critical order already keeps
  -- the truck out of service.
  if p_truck_id is not null then
    if exists (select 1 from public.work_orders w where w.company_id = v_company and w.truck_id = p_truck_id
               and w.safety_critical and w.status not in ('completed', 'closed', 'canceled')) then
      v_blockers := v_blockers || 'truck_safety_restricted'::text;
    end if;
    if exists (select 1 from public.work_orders w where w.company_id = v_company and w.truck_id = p_truck_id
               and w.scheduled_for = v_on
               and w.status in ('reported', 'triaged', 'scheduled', 'in_progress', 'awaiting_parts')) then
      v_blockers := v_blockers || 'truck_shop_scheduled'::text;
    elsif exists (select 1 from public.work_orders w where w.company_id = v_company and w.truck_id = p_truck_id
                  and w.status in ('in_progress', 'awaiting_parts')) then
      v_warnings := v_warnings || 'truck_shop_work_open'::text;
    end if;
  end if;

  if p_driver_id is not null then
    select * into v_driver from public.drivers where id = p_driver_id and company_id = v_company;
    if not found then raise exception 'Driver not found.'; end if;
    if not v_driver.active then v_blockers := v_blockers || 'driver_inactive'::text; end if;

    -- Time off (20261104000100): approved full days block; a partial day or a pending request warns.
    if exists (select 1 from public.time_off_requests t join public.employees e on e.company_id = t.company_id and e.id = t.employee_id
               where t.company_id = v_company and e.driver_id = p_driver_id and t.status = 'approved' and t.full_day
                 and v_on between t.start_date and t.end_date) then
      v_blockers := v_blockers || 'driver_time_off'::text;
    elsif exists (select 1 from public.time_off_requests t join public.employees e on e.company_id = t.company_id and e.id = t.employee_id
                  where t.company_id = v_company and e.driver_id = p_driver_id and t.status = 'approved' and not t.full_day
                    and v_on = t.start_date) then
      v_warnings := v_warnings || 'driver_partial_time_off'::text;
    end if;
    if exists (select 1 from public.time_off_requests t join public.employees e on e.company_id = t.company_id and e.id = t.employee_id
               where t.company_id = v_company and e.driver_id = p_driver_id and t.status = 'pending'
                 and v_on between t.start_date and t.end_date) then
      v_warnings := v_warnings || 'driver_time_off_pending'::text;
    end if;

    v_min := case when p_trailer_id is not null then 'A'::public.cdl_class else 'B'::public.cdl_class end;
    v_state := private.qualification_check(p_driver_id, 'cdl', v_min, v_on);
    if v_state <> 'ok' then
      v_blockers := v_blockers || ('cdl_' || v_state);
    elsif not exists (select 1 from public.driver_qualifications
                      where driver_id = p_driver_id and kind = 'cdl' and verified_at is not null
                        and private.cdl_class_rank(cdl_class) >= private.cdl_class_rank(v_min)
                        and expires_on > v_soon) then
      v_warnings := v_warnings || 'cdl_expiring_soon'::text;
    end if;

    v_state := private.qualification_check(p_driver_id, 'medical_card', null, v_on);
    if v_state <> 'ok' then
      v_blockers := v_blockers || ('medical_card_' || v_state);
    elsif not exists (select 1 from public.driver_qualifications
                      where driver_id = p_driver_id and kind = 'medical_card' and verified_at is not null
                        and expires_on > v_soon) then
      v_warnings := v_warnings || 'medical_card_expiring_soon'::text;
    end if;
  end if;

  -- Expired vehicle documents (20261112000200): the company's rule per kind decides. A verified expired document on a
  -- 'block' kind is a blocker; an unverified one, or a 'warn' kind, is a warning so a person confirms the record.
  if p_truck_id is not null then
    if exists (select 1 from private.expired_vehicle_documents(v_company, p_truck_id, null, v_on) d where d.blocks) then
      v_blockers := v_blockers || 'truck_document_expired'::text;
    elsif exists (select 1 from private.expired_vehicle_documents(v_company, p_truck_id, null, v_on)) then
      v_warnings := v_warnings || 'truck_document_review'::text;
    end if;
  end if;
  if p_trailer_id is not null then
    if exists (select 1 from private.expired_vehicle_documents(v_company, null, p_trailer_id, v_on) d where d.blocks) then
      v_blockers := v_blockers || 'trailer_document_expired'::text;
    elsif exists (select 1 from private.expired_vehicle_documents(v_company, null, p_trailer_id, v_on)) then
      v_warnings := v_warnings || 'trailer_document_review'::text;
    end if;
  end if;

  return jsonb_build_object(
    'on', v_on,
    'eligible', cardinality(v_blockers) = 0,
    'blockers', to_jsonb(v_blockers),
    'warnings', to_jsonb(v_warnings));
end;
$function$;

CREATE OR REPLACE FUNCTION private.eligibility_message(p_code text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  select case p_code
    when 'truck_inactive' then 'Truck is deactivated.'
    when 'truck_out_of_service' then 'Truck is out of service.'
    when 'truck_capacity_unknown' then 'Truck capacity is not recorded.'
    when 'truck_capacity_unverified' then 'Truck capacity is recorded but not verified.'
    when 'trailer_inactive' then 'Trailer is deactivated.'
    when 'trailer_out_of_service' then 'Trailer is out of service.'
    when 'trailer_capacity_unknown' then 'Trailer capacity is not recorded.'
    when 'trailer_capacity_unverified' then 'Trailer capacity is recorded but not verified.'
    when 'trailer_incompatible' then 'This trailer is not recorded as compatible with this truck type.'
    when 'trailer_compatibility_unknown' then 'Trailer compatibility is not recorded.'
    when 'trailer_required' then 'A tractor needs a trailer for this load.'
    when 'driver_inactive' then 'Driver is inactive.'
    when 'cdl_missing' then 'No CDL is recorded for this driver.'
    when 'cdl_class_insufficient' then 'Driver''s CDL class is not high enough for this combination.'
    when 'cdl_expired' then 'Driver''s CDL has expired.'
    when 'cdl_expiry_unknown' then 'Driver''s CDL expiry date is not recorded.'
    when 'cdl_unverified' then 'Driver''s CDL has not been verified.'
    when 'cdl_expiring_soon' then 'Driver''s CDL expires within 30 days.'
    when 'medical_card_missing' then 'No DOT medical card is recorded for this driver.'
    when 'medical_card_class_insufficient' then 'Medical card does not qualify.'
    when 'medical_card_expired' then 'Driver''s medical card has expired.'
    when 'medical_card_expiry_unknown' then 'Driver''s medical card expiry date is not recorded.'
    when 'medical_card_unverified' then 'Driver''s medical card has not been verified.'
    when 'medical_card_expiring_soon' then 'Driver''s medical card expires within 30 days.'
    when 'truck_safety_report_open' then 'A driver reported a breakdown or inspection problem on this truck that is not resolved yet.'
    when 'trailer_safety_report_open' then 'A driver reported a breakdown or inspection problem on this trailer that is not resolved yet.'
    when 'truck_equipment_report_open' then 'A driver reported an equipment issue on this truck that is not resolved yet.'
    when 'trailer_equipment_report_open' then 'A driver reported an equipment issue on this trailer that is not resolved yet.'
    when 'truck_safety_restricted' then 'Truck has an open safety-critical work order. It returns to service only after an authorized inspection clears it.'
    when 'truck_shop_scheduled' then 'Truck is scheduled in the shop on this date.'
    when 'truck_shop_work_open' then 'Truck has shop work in progress or waiting for parts — check with the shop.'
    when 'driver_time_off' then 'Driver has approved time off on this date.'
    when 'driver_partial_time_off' then 'Driver has approved partial-day time off on this date — check the load times.'
    when 'driver_time_off_pending' then 'Driver has a pending time-off request on this date.'
    when 'truck_document_expired' then 'A verified insurance or registration (or another kind the company blocks on) has expired for this truck.'
    when 'trailer_document_expired' then 'A verified insurance or registration (or another kind the company blocks on) has expired for this trailer.'
    when 'truck_document_review' then 'A document on record for this truck has expired — confirm it was renewed.'
    when 'trailer_document_review' then 'A document on record for this trailer has expired — confirm it was renewed.'
    else p_code
  end
$function$;

CREATE OR REPLACE FUNCTION private.check_assignment(p_company uuid, p_truck_id uuid, p_trailer_id uuid, p_driver_id uuid, p_on date, p_starts timestamp with time zone, p_ends timestamp with time zone, p_except uuid)
 RETURNS text[]
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_result   jsonb;
  v_blockers text[];
  v_type     public.truck_type;
  v_conflict text;
begin
  if p_truck_id is null or p_driver_id is null then
    raise exception 'Choose a truck and a driver.';
  end if;
  -- Raises "Truck/Trailer/Driver not found." for ids outside the company.
  v_result := private.assignment_eligibility(p_company, p_truck_id, p_trailer_id, p_driver_id, p_on);
  select array(select jsonb_array_elements_text(v_result -> 'blockers')) into v_blockers;
  select truck_type into v_type from public.trucks where id = p_truck_id and company_id = p_company;
  if v_type = 'tractor' and p_trailer_id is null then
    v_blockers := v_blockers || 'trailer_required'::text;
  end if;
  if cardinality(v_blockers) > 0 then
    -- Expired documents are named (vehicle, kind, date) with the corrective action.
    raise exception 'Not eligible on %: %', to_char(p_on, 'Mon FMDD, YYYY'),
      trim(coalesce((select string_agg(private.eligibility_message(b), ' ') from unnest(v_blockers) b where b not like '%document_expired'), '')
      || coalesce((select ' ' || string_agg(format('%s %s: %s expired %s — record the renewed document in Fleet, or change the company rule in Settings.',
                       d.vehicle_kind, d.unit_number, d.kind, to_char(d.expires_on, 'Mon FMDD, YYYY')), ' ')
                from private.expired_vehicle_documents(p_company, p_truck_id, p_trailer_id, p_on) d where d.blocks), ''));
  end if;

  -- Approved time off overlapping the load's exact times (20261104000100).
  v_conflict := private.driver_time_off_conflict(p_company, p_driver_id, p_starts, p_ends);
  if v_conflict is not null then
    raise exception '%', v_conflict;
  end if;

  v_conflict := coalesce(
    private.resource_conflict(p_company, 'truck', p_truck_id, p_starts, p_ends, p_except),
    case when p_trailer_id is not null then private.resource_conflict(p_company, 'trailer', p_trailer_id, p_starts, p_ends, p_except) end,
    private.resource_conflict(p_company, 'driver', p_driver_id, p_starts, p_ends, p_except));
  if v_conflict is not null then
    raise exception '%', v_conflict;
  end if;

  return array(select jsonb_array_elements_text(v_result -> 'warnings'));
end;
$function$;
