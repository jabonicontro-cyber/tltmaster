-- =============================================================================
-- Part on order, job not started (owner decision 2026-11-09, master plan MD1).
--
-- Until now any job waiting for parts kept its truck or trailer out of dispatch (20261120009800). Since
-- 20261120012300 a job may wait for parts before anyone starts it (reported, triaged or scheduled -> awaiting_parts):
-- the truck is still in the yard and can run. New rule:
--   * a job waiting for parts that has NOT started and is not safety-critical leaves the unit dispatchable with a
--     warning (truck_part_on_order / trailer_part_on_order); the board and the Assign window show
--     "Part on order: <part>, expected <date>";
--   * once work has started (in progress, or waiting for parts after being in progress) the unit stays blocked
--     (truck_shop_work_open / trailer_shop_work_open), and a safety-critical job blocks as before.
--
-- How "started" is known: public.work_orders.work_started_at, the first time the job went in progress (or straight to
-- awaiting inspection, completed or closed), or the first time a mechanic recorded time on it. The status history
-- alone would need a lookup in every check, on every page; one column set by triggers (on every status change, whatever
-- function changes it, and on recorded time) keeps the database rule and the app's rule (src/lib/fleet/readiness.ts)
-- on the same fact. It is never cleared: a job that started and went back to the queue has started.
-- Existing jobs: set from the status history (first move to in progress or later), recorded time (not voided), or the
-- current status. A job waiting for parts with no record that it got there before work started is counted as started,
-- so it keeps blocking exactly as before (nothing becomes dispatchable on a guess).
--
-- private.assignment_eligibility and private.eligibility_message: the rule above (bodies otherwise identical to
-- 20261120009800). public.dispatch_shop_schedule (the board, Taviron Live, availability, Smart Dispatch and Plan the
-- day read it): each job also carries work_started_at and its parts still on order (description, expected date), so
-- the pages apply the same rule and show the note. Body otherwise identical to 20261120002100.
-- Additive; works with the code before and after it (before it the app does not read the column and keeps blocking).
-- Reversible: supabase/rollbacks/20261120015000_part_on_order.down.sql
-- =============================================================================

alter table public.work_orders add column if not exists work_started_at timestamptz;
comment on column public.work_orders.work_started_at is
  'When work first started on the job (first move to in progress or later, or first recorded time). Null: never started. Set by triggers; never cleared.';

create or replace function private.wo_mark_started()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.work_started_at is null and new.status in ('in_progress', 'awaiting_inspection', 'completed', 'closed') then
    new.work_started_at := now();
  end if;
  -- Once started, always started (an update cannot clear it).
  if tg_op = 'UPDATE' and old.work_started_at is not null then
    new.work_started_at := old.work_started_at;
  end if;
  return new;
end;
$$;
revoke all on function private.wo_mark_started() from public, anon, authenticated;

drop trigger if exists work_orders_started on public.work_orders;
create trigger work_orders_started before insert or update of status, work_started_at on public.work_orders
  for each row execute function private.wo_mark_started();

-- Time recorded on a job is work done on it: the first time entry marks the job started too.
create or replace function private.wo_mark_started_by_time()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.work_orders set work_started_at = least(new.started_at, now())
  where id = new.work_order_id and company_id = new.company_id and work_started_at is null;
  return null;
end;
$$;
revoke all on function private.wo_mark_started_by_time() from public, anon, authenticated;

drop trigger if exists work_order_time_started on public.work_order_time_entries;
create trigger work_order_time_started after insert on public.work_order_time_entries
  for each row execute function private.wo_mark_started_by_time();

-- Existing jobs (the audit trigger is paused: this fills a new column, it is not a change anyone made).
alter table public.work_orders disable trigger work_orders_audit;
update public.work_orders w set work_started_at = s.started
from (
  select o.id, coalesce(
    (select min(e.created_at) from public.work_order_events e
      where e.work_order_id = o.id and e.kind = 'status' and e.to_status in ('in_progress', 'awaiting_inspection', 'completed', 'closed')),
    (select min(t.started_at) from public.work_order_time_entries t where t.work_order_id = o.id and t.voided_at is null),
    case when o.status in ('in_progress', 'awaiting_inspection', 'completed', 'closed') then coalesce(o.completed_at, o.updated_at, o.created_at) end,
    case when o.status = 'awaiting_parts' and not exists (
           select 1 from public.work_order_events e where e.work_order_id = o.id and e.kind = 'status'
             and e.to_status = 'awaiting_parts' and e.from_status in ('reported', 'triaged', 'scheduled'))
         then o.updated_at end) as started
  from public.work_orders o
  where o.work_started_at is null
) s
where s.id = w.id and s.started is not null;
alter table public.work_orders enable trigger work_orders_audit;


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
    when 'truck_shop_work_open' then 'Truck is in the shop: work is in progress or waiting for parts. It cannot be assigned until the work is done.'
    when 'trailer_safety_restricted' then 'Trailer has an open safety-critical work order. It returns to service only after an authorized inspection clears it.'
    when 'trailer_shop_scheduled' then 'Trailer is scheduled in the shop on this date.'
    when 'trailer_shop_work_open' then 'Trailer is in the shop: work is in progress or waiting for parts. It cannot be assigned until the work is done.'
    when 'truck_part_on_order' then 'A part is on order for a job on this truck that has not started. The truck can run until the work starts.'
    when 'trailer_part_on_order' then 'A part is on order for a job on this trailer that has not started. The trailer can run until the work starts.'
    when 'driver_time_off' then 'Driver has approved time off on this date.'
    when 'driver_partial_time_off' then 'Driver has approved partial-day time off on this date. Check the load times.'
    when 'driver_time_off_pending' then 'Driver has a pending time-off request on this date.'
    when 'truck_document_expired' then 'A verified insurance or registration (or another kind the company blocks on) has expired for this truck.'
    when 'trailer_document_expired' then 'A verified insurance or registration (or another kind the company blocks on) has expired for this trailer.'
    when 'truck_document_review' then 'A document on record for this truck has expired. Confirm it was renewed.'
    when 'trailer_document_review' then 'A document on record for this trailer has expired. Confirm it was renewed.'
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

  -- Maintenance (20261101000100; 20261120009800, owner 2026-11-09 WK1; 20261120015000, MD1): open
  -- safety-critical work orders, shop visits on the load date, and shop work that has started (in progress, or waiting
  -- for parts after work started) block. A job waiting for parts that never started and is not safety-critical leaves
  -- the unit dispatchable with a warning (*_part_on_order). Defensive: a safety-critical order already keeps the unit
  -- out of service.
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
                  and (w.status = 'in_progress'
                       or (w.status = 'awaiting_parts' and (w.work_started_at is not null or w.safety_critical)))) then
      v_blockers := v_blockers || 'truck_shop_work_open'::text;
    elsif exists (select 1 from public.work_orders w where w.company_id = v_company and w.truck_id = p_truck_id
                  and w.status = 'awaiting_parts' and w.work_started_at is null and not w.safety_critical) then
      v_warnings := v_warnings || 'truck_part_on_order'::text;
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
                  and (w.status = 'in_progress'
                       or (w.status = 'awaiting_parts' and (w.work_started_at is not null or w.safety_critical)))) then
      v_blockers := v_blockers || 'trailer_shop_work_open'::text;
    elsif exists (select 1 from public.work_orders w where w.company_id = v_company and w.trailer_id = p_trailer_id
                  and w.status = 'awaiting_parts' and w.work_started_at is null and not w.safety_critical) then
      v_warnings := v_warnings || 'trailer_part_on_order'::text;
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

-- The shop schedule for dispatch (dispatch.view), as 20261120002100, with work_started_at and the job's parts still on
-- order (description and expected date; never the cost) on each job.
create or replace function public.dispatch_shop_schedule(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v_bases   uuid[] := private.my_bases();
begin
  perform private.require_permission('dispatch.view');
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 62 then
    raise exception 'Choose a date range of at most 62 days.';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'truck_id', w.truck_id, 'trailer_id', w.trailer_id, 'work_order_id', w.id, 'number', w.number, 'title', w.title, 'status', w.status,
      'scheduled_for', w.scheduled_for, 'safety_critical', w.safety_critical, 'work_started_at', w.work_started_at,
      'parts', coalesce((select jsonb_agg(jsonb_build_object('description', p.description, 'expected_on', p.expected_on)
                                          order by p.expected_on nulls last, p.created_at)
                         from public.work_order_part_waits p
                         where p.company_id = w.company_id and p.work_order_id = w.id and p.status = 'waiting'), '[]'::jsonb))
      order by w.scheduled_for nulls first, w.number)
    from public.work_orders w
    left join public.trucks t on t.id = w.truck_id and t.company_id = w.company_id
    left join public.trailers l on l.id = w.trailer_id and l.company_id = w.company_id
    where w.company_id = v_company
      and w.status in ('reported', 'triaged', 'scheduled', 'in_progress', 'awaiting_parts', 'awaiting_inspection')
      and (w.safety_critical or w.status in ('in_progress', 'awaiting_parts') or w.scheduled_for between p_from and p_to)
      and (v_bases is null
           or ((t.base_id is null or t.base_id = any (v_bases)) and (l.base_id is null or l.base_id = any (v_bases))))
  ), '[]'::jsonb);
end;
$$;
