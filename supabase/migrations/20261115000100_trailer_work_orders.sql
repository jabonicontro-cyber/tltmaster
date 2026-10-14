-- =============================================================================
-- Trailer work orders (2026-10-14, master plan B48).
--
-- Until now a work order always belonged to a truck, so a trailer with a
-- safety-critical defect could only be blocked by hand (service status) or by
-- an open driver report. A work order now belongs to exactly one truck or one
-- trailer:
--   * work_orders.trailer_id (truck_id becomes nullable; exactly one is set).
--     Preventive schedules stay truck-only (readings are truck readings).
--   * A safety-critical trailer work order takes the trailer out of service
--     and only an authorized inspection returns it (same rule and the same
--     clearance queue as trucks; guard trigger on trailers).
--   * Dispatch eligibility gains trailer_safety_restricted and
--     trailer_shop_scheduled (blockers) and trailer_shop_work_open (warning),
--     mirroring the truck codes.
--   * Alerts, the dispatch shop schedule and the driver's maintenance notices
--     name the trailer.
-- Functions are replaced in full from their current definitions with only the
-- trailer handling added. No existing row changes (every existing order has a
-- truck). Rollback: supabase/rollbacks/20261115000100_trailer_work_orders.down.sql
-- =============================================================================

alter table public.work_orders alter column truck_id drop not null;
alter table public.work_orders add column trailer_id uuid;
alter table public.work_orders add constraint work_orders_trailer_fk
  foreign key (company_id, trailer_id) references public.trailers (company_id, id);
alter table public.work_orders add constraint work_orders_one_unit check (num_nonnulls(truck_id, trailer_id) = 1);
alter table public.work_orders add constraint work_orders_schedule_truck check (schedule_id is null or truck_id is not null);
create index work_orders_trailer_idx on public.work_orders (company_id, trailer_id, status) where trailer_id is not null;
comment on column public.work_orders.restricted_truck is
  'True while this order holds its truck or trailer out of service (the name predates trailer work orders).';

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
    when 'trailer_safety_restricted' then 'Trailer has an open safety-critical work order. It returns to service only after an authorized inspection clears it.'
    when 'trailer_shop_scheduled' then 'Trailer is scheduled in the shop on this date.'
    when 'trailer_shop_work_open' then 'Trailer has shop work in progress or waiting for parts — check with the shop.'
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
  if p_trailer_id is not null then
    if exists (select 1 from public.work_orders w where w.company_id = v_company and w.trailer_id = p_trailer_id
               and w.safety_critical and w.status not in ('completed', 'closed', 'canceled')) then
      v_blockers := v_blockers || 'trailer_safety_restricted'::text;
    end if;
    if exists (select 1 from public.work_orders w where w.company_id = v_company and w.trailer_id = p_trailer_id
               and w.scheduled_for = v_on
               and w.status in ('reported', 'triaged', 'scheduled', 'in_progress', 'awaiting_parts')) then
      v_blockers := v_blockers || 'trailer_shop_scheduled'::text;
    elsif exists (select 1 from public.work_orders w where w.company_id = v_company and w.trailer_id = p_trailer_id
                  and w.status in ('in_progress', 'awaiting_parts')) then
      v_warnings := v_warnings || 'trailer_shop_work_open'::text;
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

CREATE OR REPLACE FUNCTION private.alerts_from_work_orders()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_unit text;
  v_kind text := case when new.trailer_id is not null then 'trailer' else 'truck' end;
begin
  if new.trailer_id is not null then
    select unit_number into v_unit from public.trailers where id = new.trailer_id;
  else
    select unit_number into v_unit from public.trucks where id = new.truck_id;
  end if;
  if new.safety_critical and new.status not in ('completed', 'closed', 'canceled')
     and (tg_op = 'INSERT' or not old.safety_critical or old.status in ('completed', 'closed', 'canceled')) then
    perform private.comm_raise_alert(new.company_id, 'maintenance.safety_restriction', new.id::text, v_kind, coalesce(new.trailer_id, new.truck_id),
      initcap(v_kind) || ' ' || v_unit || ' restricted: ' || new.title,
      'Work order ' || new.number || '. The ' || v_kind || ' cannot be dispatched until cleared.',
      '/maintenance/work-orders/' || new.id, private.alert_users_with(new.company_id, array['comms.alerts', 'maintenance.clear']));
  elsif tg_op = 'UPDATE' and old.safety_critical and (new.status in ('completed', 'closed', 'canceled') or not new.safety_critical) then
    perform private.comm_resolve_alert(new.company_id, 'maintenance.safety_restriction', new.id::text,
      case when new.clearance_status = 'cleared' then 'Cleared for service after inspection' when new.status = 'canceled' then 'Work order canceled'
           else 'Safety-critical flag removed' end);
  end if;
  return null;
end;
$function$;

CREATE OR REPLACE FUNCTION private.wo_restrict_truck(p_wo uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_wo    public.work_orders%rowtype;
  v_truck public.trucks%rowtype;
  v_trailer public.trailers%rowtype;
begin
  select * into v_wo from public.work_orders where id = p_wo;
  if v_wo.trailer_id is not null then
    select * into v_trailer from public.trailers where id = v_wo.trailer_id and company_id = v_wo.company_id for update;
    if v_trailer.service_status = 'in_service' then
      update public.trailers set
        service_status = 'out_of_service',
        out_of_service_reason = left('Safety-critical defect — work order ' || v_wo.number || ': ' || v_wo.title, 500),
        out_of_service_since = now(),
        expected_return_date = null
      where id = v_trailer.id;
      insert into public.equipment_status_events (company_id, trailer_id, from_status, to_status, reason, actor_id)
      values (v_wo.company_id, v_trailer.id, 'in_service', 'out_of_service',
              left('Safety-critical defect — work order ' || v_wo.number, 500), auth.uid());
      update public.work_orders set restricted_truck = true where id = p_wo;
      perform private.wo_event(v_wo.company_id, p_wo, 'restricted', null, null,
        'Trailer ' || v_trailer.unit_number || ' taken out of service until an authorized inspection clears it.');
    else
      perform private.wo_event(v_wo.company_id, p_wo, 'restricted', null, null,
        'Trailer ' || v_trailer.unit_number || ' was already out of service; it stays restricted until this work order is cleared.');
    end if;
    return;
  end if;
  select * into v_truck from public.trucks where id = v_wo.truck_id and company_id = v_wo.company_id for update;
  if v_truck.service_status = 'in_service' then
    update public.trucks set
      service_status = 'out_of_service',
      out_of_service_reason = left('Safety-critical defect — work order ' || v_wo.number || ': ' || v_wo.title, 500),
      out_of_service_since = now(),
      expected_return_date = null
    where id = v_truck.id;
    insert into public.equipment_status_events (company_id, truck_id, from_status, to_status, reason, actor_id)
    values (v_wo.company_id, v_truck.id, 'in_service', 'out_of_service',
            left('Safety-critical defect — work order ' || v_wo.number, 500), auth.uid());
    update public.work_orders set restricted_truck = true where id = p_wo;
    perform private.wo_event(v_wo.company_id, p_wo, 'restricted', null, null,
      'Truck ' || v_truck.unit_number || ' taken out of service until an authorized inspection clears it.');
  else
    perform private.wo_event(v_wo.company_id, p_wo, 'restricted', null, null,
      'Truck ' || v_truck.unit_number || ' was already out of service; it stays restricted until this work order is cleared.');
  end if;
end;
$function$;

CREATE OR REPLACE FUNCTION private.wo_release_truck(p_wo uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_wo    public.work_orders%rowtype;
  v_truck public.trucks%rowtype;
  v_trailer public.trailers%rowtype;
begin
  select * into v_wo from public.work_orders where id = p_wo;
  if not v_wo.restricted_truck then
    return false;
  end if;
  if v_wo.trailer_id is not null then
    select * into v_trailer from public.trailers where id = v_wo.trailer_id and company_id = v_wo.company_id for update;
    if v_trailer.service_status <> 'out_of_service' or exists (
      select 1 from public.work_orders w
      where w.company_id = v_wo.company_id and w.trailer_id = v_wo.trailer_id and w.id <> p_wo
        and w.safety_critical and w.status not in ('completed', 'closed', 'canceled')) then
      return false;
    end if;
    update public.trailers set service_status = 'in_service', out_of_service_reason = '', out_of_service_since = null,
      expected_return_date = null
    where id = v_trailer.id;
    insert into public.equipment_status_events (company_id, trailer_id, from_status, to_status, reason, actor_id)
    values (v_wo.company_id, v_trailer.id, 'out_of_service', 'in_service',
            left('Cleared after inspection — work order ' || v_wo.number, 500), auth.uid());
    update public.work_orders set restricted_truck = false where id = p_wo;
    perform private.wo_event(v_wo.company_id, p_wo, 'returned_to_service', null, null,
      'Trailer ' || v_trailer.unit_number || ' returned to service.');
    return true;
  end if;
  select * into v_truck from public.trucks where id = v_wo.truck_id and company_id = v_wo.company_id for update;
  if v_truck.service_status <> 'out_of_service' or exists (
    select 1 from public.work_orders w
    where w.company_id = v_wo.company_id and w.truck_id = v_wo.truck_id and w.id <> p_wo
      and w.safety_critical and w.status not in ('completed', 'closed', 'canceled')) then
    return false;
  end if;
  update public.trucks set service_status = 'in_service', out_of_service_reason = '', out_of_service_since = null,
    expected_return_date = null
  where id = v_truck.id;
  insert into public.equipment_status_events (company_id, truck_id, from_status, to_status, reason, actor_id)
  values (v_wo.company_id, v_truck.id, 'out_of_service', 'in_service',
          left('Cleared after inspection — work order ' || v_wo.number, 500), auth.uid());
  update public.work_orders set restricted_truck = false where id = p_wo;
  perform private.wo_event(v_wo.company_id, p_wo, 'returned_to_service', null, null,
    'Truck ' || v_truck.unit_number || ' returned to service.');
  return true;
end;
$function$;

CREATE OR REPLACE FUNCTION private.guard_trailer_clearance()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_number text;
begin
  if new.service_status = 'in_service' and old.service_status = 'out_of_service' then
    select w.number into v_number from public.work_orders w
    where w.company_id = new.company_id and w.trailer_id = new.id and w.safety_critical
      and w.status not in ('completed', 'closed', 'canceled')
    limit 1;
    if v_number is not null then
      raise exception 'Trailer % has an open safety-critical work order (%). It returns to service only after an authorized inspection clears it in Maintenance.', new.unit_number, v_number
        using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$function$;

create trigger trailers_clearance_guard before update of service_status on public.trailers
  for each row execute function private.guard_trailer_clearance();
revoke all on function private.guard_trailer_clearance() from public, anon, authenticated;

CREATE OR REPLACE FUNCTION public.maintenance_create_work_order(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_company  uuid := private.require_company();
  v_key      uuid := nullif(p ->> 'submission_key', '')::uuid;
  v_truck    uuid := nullif(p ->> 'truck_id', '')::uuid;
  v_trailer  uuid := nullif(p ->> 'trailer_id', '')::uuid;
  v_driver   uuid := nullif(p ->> 'driver_id', '')::uuid;
  v_report   uuid := nullif(p ->> 'field_report_id', '')::uuid;
  v_assignee uuid := nullif(p ->> 'assigned_to', '')::uuid;
  v_sched    date := nullif(p ->> 'scheduled_for', '')::date;
  v_safety   boolean := coalesce((p ->> 'safety_critical')::boolean, false);
  v_existing public.work_orders%rowtype;
  v_id       uuid;
  v_number   text;
  v_status   text;
begin
  perform private.require_permission('maintenance.manage');
  if v_key is not null then
    select * into v_existing from public.work_orders where company_id = v_company and submission_key = v_key;
    if found then
      return jsonb_build_object('id', v_existing.id, 'number', v_existing.number, 'duplicate', true);
    end if;
  end if;
  if v_truck is not null and v_trailer is not null then
    raise exception 'Choose either a truck or a trailer, not both.' using errcode = 'P0001';
  end if;
  if v_trailer is not null then
    if not exists (select 1 from public.trailers where id = v_trailer and company_id = v_company) then
      raise exception 'Choose a trailer.' using errcode = 'P0002';
    end if;
  elsif not exists (select 1 from public.trucks where id = v_truck and company_id = v_company) then
    raise exception 'Choose a truck.' using errcode = 'P0002';
  end if;
  perform private.wo_validate_refs(v_company, v_driver, v_assignee, v_report);
  if v_sched is not null and v_sched < private.business_today(v_company) then
    raise exception 'The scheduled date cannot be in the past.';
  end if;

  v_status := case when v_sched is not null then 'scheduled' else 'reported' end;
  v_number := private.next_document_number(v_company, 'work_order');
  insert into public.work_orders (company_id, number, truck_id, trailer_id, driver_id, field_report_id, title, description,
    category, urgency, safety_critical, status, assigned_to, scheduled_for, due_on, source, submission_key, created_by)
  values (v_company, v_number, v_truck, v_trailer, v_driver, v_report,
    private.clean_text(p ->> 'title', 120, 'Title'), private.clean_text(p ->> 'description', 4000, 'Description'),
    coalesce(nullif(p ->> 'category', ''), 'repair'), coalesce(nullif(p ->> 'urgency', ''), 'normal'),
    v_safety, v_status, v_assignee, v_sched, nullif(p ->> 'due_on', '')::date,
    case when v_report is not null then 'field_report' else 'manual' end, v_key, auth.uid())
  returning id into v_id;

  perform private.wo_event(v_company, v_id, 'created', null, v_status, '');
  if v_sched is not null then
    perform private.wo_event(v_company, v_id, 'scheduled', null, null, '', jsonb_build_object('scheduled_for', v_sched));
  end if;
  if v_safety then
    perform private.wo_restrict_truck(v_id);
  end if;
  return jsonb_build_object('id', v_id, 'number', v_number, 'duplicate', false);
exception
  when unique_violation then
    -- A concurrent submit with the same key won the race.
    select * into v_existing from public.work_orders where company_id = v_company and submission_key = v_key;
    if found then
      return jsonb_build_object('id', v_existing.id, 'number', v_existing.number, 'duplicate', true);
    end if;
    raise;
end;
$function$;

CREATE OR REPLACE FUNCTION public.dispatch_shop_schedule(p_from date, p_to date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_company uuid := private.require_company();
begin
  perform private.require_permission('dispatch.view');
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 62 then
    raise exception 'Choose a date range of at most 62 days.';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'truck_id', w.truck_id, 'trailer_id', w.trailer_id, 'work_order_id', w.id, 'number', w.number, 'title', w.title, 'status', w.status,
      'scheduled_for', w.scheduled_for, 'safety_critical', w.safety_critical) order by w.scheduled_for nulls first, w.number)
    from public.work_orders w
    where w.company_id = v_company
      and w.status in ('reported', 'triaged', 'scheduled', 'in_progress', 'awaiting_parts', 'awaiting_inspection')
      and (w.safety_critical or w.status in ('in_progress', 'awaiting_parts') or w.scheduled_for between p_from and p_to)
  ), '[]'::jsonb);
end;
$function$;

CREATE OR REPLACE FUNCTION public.driver_maintenance_notices()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_company uuid := private.require_company();
  v_driver  public.drivers%rowtype;
  v_today   date := private.business_today(v_company);
begin
  select * into v_driver from public.drivers
  where company_id = v_company and user_id = auth.uid() and active
  limit 1;
  if not found then
    return '[]'::jsonb;
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'number', w.number, 'unit_number', coalesce(t.unit_number, tr.unit_number),
      'equipment', case when w.trailer_id is not null then 'trailer' else 'truck' end, 'title', w.title, 'status', w.status,
      'scheduled_for', w.scheduled_for, 'safety_critical', w.safety_critical,
      'notice', e.kind, 'notice_at', e.created_at, 'previous_date', e.details ->> 'from')
      order by coalesce(w.scheduled_for, v_today), w.number)
    from public.work_orders w
    left join public.trucks t on t.company_id = w.company_id and t.id = w.truck_id
    left join public.trailers tr on tr.company_id = w.company_id and tr.id = w.trailer_id
    join lateral (
      select ev.kind, ev.created_at, ev.details from public.work_order_events ev
      where ev.company_id = w.company_id and ev.work_order_id = w.id
        and ev.kind in ('scheduled', 'rescheduled', 'canceled')
      order by ev.created_at desc limit 1) e on true
    where w.company_id = v_company
      and (w.truck_id = v_driver.primary_truck_id or w.driver_id = v_driver.id
           or (w.trailer_id is not null and tr.default_truck_id = v_driver.primary_truck_id))
      and ((w.status not in ('completed', 'closed', 'canceled') and w.scheduled_for >= v_today - 1)
           or (w.status = 'canceled' and e.kind = 'canceled' and e.created_at > now() - interval '7 days'
               and (e.details ->> 'scheduled_for') is not null))
  ), '[]'::jsonb);
end;
$function$;

