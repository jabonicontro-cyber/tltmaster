-- Rollback of 20261112000200_document_policy.sql (not a migration; run by hand with a backup first).
-- Restores the eligibility functions as they were before (from the database, 2026-10-13) and removes document rules
-- and document verification. Rules and verification marks are lost: export them first if they must be kept.
begin;
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
    raise exception 'Not eligible on %: %', to_char(p_on, 'Mon FMDD, YYYY'),
      (select string_agg(private.eligibility_message(b), ' ') from unnest(v_blockers) b);
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

drop function if exists public.dispatch_document_issues(date);
drop function if exists public.document_rules();
drop function if exists public.set_document_rule(text, text);
drop function if exists public.verify_vehicle_document(uuid);
drop function if exists private.expired_vehicle_documents(uuid, uuid, uuid, date);
drop function if exists private.document_rule(uuid, text);
drop trigger if exists vehicle_documents_unverify on public.vehicle_documents;
drop function if exists private.unverify_changed_document();
alter table public.vehicle_documents drop column if exists verified_by;
alter table public.vehicle_documents drop column if exists verified_at;
drop table if exists public.vehicle_document_rules;
commit;
