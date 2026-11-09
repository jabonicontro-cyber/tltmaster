-- =============================================================================
-- Trucks and trailers stuck out of service (bug fix, 2026-11-09).
--
-- A safety-critical work order takes its unit out of service and marks itself
-- restricted_truck ("this order holds the unit"). Before this fix only the FIRST
-- such order carried the mark: a second safety-critical order on a unit that was
-- already out of service did not. When the first order was cleared while the
-- second was open, the unit stayed out (correct) but the mark stayed on the
-- cleared order, so clearing the second order never returned the unit, and the
-- stored reason kept naming the cleared order.
--
-- Now:
--   * private.wo_restrict_truck: a safety-critical order on a unit that is out of
--     service BECAUSE OF an open safety-critical order (another order holds it)
--     joins the hold (restricted_truck = true) and the stored reason is rewritten
--     to name every open safety-critical order. A unit a person took out of
--     service by hand (no order holds it) keeps that person's reason and is never
--     returned automatically, as before.
--   * private.wo_release_truck: when a holding order is cleared, canceled or
--     downgraded while other open safety-critical orders remain, the hold passes
--     to them (their mark is set, this order's mark is cleared) and the reason is
--     rewritten to name them. The unit returns to service when the last holding
--     order clears.
--   * private.wo_hold_reason: the reason text for the open safety-critical orders
--     on a unit (the same words as src/lib/maintenance.ts currentRestrictionReason).
--   * One-time repair of units stuck by the old behaviour: on a unit that is out
--     of service, held by an order that is no longer open, while open
--     safety-critical orders remain, the hold moves to those orders and the reason
--     is rewritten. Units with no open safety-critical order left are NOT returned
--     to service here: a person decides (the fleet page allows it; nothing blocks
--     it). Equipment status events are not written for the repair (the status does
--     not change).
--
-- Works with the code before and after it (same signatures, same results for
-- every single-order case). Reversible:
-- supabase/rollbacks/20261120012000_unit_hold_release.down.sql (restores the
-- 20261120007200 definitions; the repaired marks stay, which is harmless).
-- =============================================================================

-- The reason for the open safety-critical work orders on a truck or trailer (oldest first); '' when none is open.
create or replace function private.wo_hold_reason(p_company uuid, p_truck uuid, p_trailer uuid)
returns text
language sql
stable
set search_path = ''
as $$
  with open_safety as (
    select w.number, w.title, w.created_at from public.work_orders w
    where w.company_id = p_company and w.safety_critical and w.status not in ('completed', 'closed', 'canceled')
      and ((p_truck is not null and w.truck_id = p_truck) or (p_trailer is not null and w.trailer_id = p_trailer))
  )
  select case
    when (select count(*) from open_safety) = 0 then ''
    when (select count(*) from open_safety) = 1 then
      (select left('Safety-critical defect, work order ' || o.number || ': ' || o.title, 500) from open_safety o)
    else left('Safety-critical defects, work orders ' ||
      (select string_agg(o.number, ', ' order by o.created_at, o.number) from open_safety o), 500)
  end;
$$;
revoke all on function private.wo_hold_reason(uuid, uuid, uuid) from public, anon, authenticated;

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
  v_held  boolean;
begin
  select * into v_wo from public.work_orders where id = p_wo;
  if v_wo.trailer_id is not null then
    select * into v_trailer from public.trailers where id = v_wo.trailer_id and company_id = v_wo.company_id for update;
    if v_trailer.service_status = 'in_service' then
      update public.trailers set
        service_status = 'out_of_service',
        out_of_service_reason = left('Safety-critical defect, work order ' || v_wo.number || ': ' || v_wo.title, 500),
        out_of_service_since = now(),
        expected_return_date = null
      where id = v_trailer.id;
      insert into public.equipment_status_events (company_id, trailer_id, from_status, to_status, reason, actor_id)
      values (v_wo.company_id, v_trailer.id, 'in_service', 'out_of_service',
              left('Safety-critical defect, work order ' || v_wo.number, 500), auth.uid());
      update public.work_orders set restricted_truck = true where id = p_wo;
      perform private.wo_event(v_wo.company_id, p_wo, 'restricted', null, null,
        'Trailer ' || v_trailer.unit_number || ' taken out of service until an authorized inspection clears it.');
      return;
    end if;
    -- Out of service already: held by another open safety-critical order (join the hold), or by a person (leave it).
    select exists (select 1 from public.work_orders w
      where w.company_id = v_wo.company_id and w.trailer_id = v_wo.trailer_id and w.id <> p_wo and w.restricted_truck
        and w.safety_critical and w.status not in ('completed', 'closed', 'canceled')) into v_held;
    if v_held then
      update public.work_orders set restricted_truck = true where id = p_wo;
      update public.trailers set out_of_service_reason = private.wo_hold_reason(v_wo.company_id, null, v_trailer.id)
      where id = v_trailer.id;
    end if;
    perform private.wo_event(v_wo.company_id, p_wo, 'restricted', null, null,
      'Trailer ' || v_trailer.unit_number || ' was already out of service; it stays restricted until this work order is cleared.');
    return;
  end if;
  select * into v_truck from public.trucks where id = v_wo.truck_id and company_id = v_wo.company_id for update;
  if v_truck.service_status = 'in_service' then
    update public.trucks set
      service_status = 'out_of_service',
      out_of_service_reason = left('Safety-critical defect, work order ' || v_wo.number || ': ' || v_wo.title, 500),
      out_of_service_since = now(),
      expected_return_date = null
    where id = v_truck.id;
    insert into public.equipment_status_events (company_id, truck_id, from_status, to_status, reason, actor_id)
    values (v_wo.company_id, v_truck.id, 'in_service', 'out_of_service',
            left('Safety-critical defect, work order ' || v_wo.number, 500), auth.uid());
    update public.work_orders set restricted_truck = true where id = p_wo;
    perform private.wo_event(v_wo.company_id, p_wo, 'restricted', null, null,
      'Truck ' || v_truck.unit_number || ' taken out of service until an authorized inspection clears it.');
    return;
  end if;
  select exists (select 1 from public.work_orders w
    where w.company_id = v_wo.company_id and w.truck_id = v_wo.truck_id and w.id <> p_wo and w.restricted_truck
      and w.safety_critical and w.status not in ('completed', 'closed', 'canceled')) into v_held;
  if v_held then
    update public.work_orders set restricted_truck = true where id = p_wo;
    update public.trucks set out_of_service_reason = private.wo_hold_reason(v_wo.company_id, v_truck.id, null)
    where id = v_truck.id;
  end if;
  perform private.wo_event(v_wo.company_id, p_wo, 'restricted', null, null,
    'Truck ' || v_truck.unit_number || ' was already out of service; it stays restricted until this work order is cleared.');
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
  v_left  text;
begin
  select * into v_wo from public.work_orders where id = p_wo;
  if not v_wo.restricted_truck then
    -- This order never held the unit (a person had taken it out of service): nothing to return.
    return false;
  end if;
  if v_wo.trailer_id is not null then
    select * into v_trailer from public.trailers where id = v_wo.trailer_id and company_id = v_wo.company_id for update;
    if v_trailer.service_status <> 'out_of_service' then
      update public.work_orders set restricted_truck = false where id = p_wo;
      return false;
    end if;
    select string_agg(w.number, ', ' order by w.created_at, w.number) into v_left from public.work_orders w
    where w.company_id = v_wo.company_id and w.trailer_id = v_wo.trailer_id and w.id <> p_wo
      and w.safety_critical and w.status not in ('completed', 'closed', 'canceled');
    if v_left is not null then
      -- Other safety-critical orders remain: they hold the trailer now, and the reason names them.
      update public.work_orders set restricted_truck = true
      where company_id = v_wo.company_id and trailer_id = v_wo.trailer_id and id <> p_wo
        and safety_critical and status not in ('completed', 'closed', 'canceled') and not restricted_truck;
      update public.work_orders set restricted_truck = false where id = p_wo;
      update public.trailers set out_of_service_reason = private.wo_hold_reason(v_wo.company_id, null, v_trailer.id)
      where id = v_trailer.id;
      perform private.wo_event(v_wo.company_id, p_wo, 'restricted', null, null,
        'Trailer ' || v_trailer.unit_number || ' stays out of service until ' ||
        case when position(',' in v_left) > 0 then 'work orders ' else 'work order ' end || v_left ||
        case when position(',' in v_left) > 0 then ' are' else ' is' end || ' cleared.');
      return false;
    end if;
    update public.trailers set service_status = 'in_service', out_of_service_reason = '', out_of_service_since = null,
      expected_return_date = null
    where id = v_trailer.id;
    insert into public.equipment_status_events (company_id, trailer_id, from_status, to_status, reason, actor_id)
    values (v_wo.company_id, v_trailer.id, 'out_of_service', 'in_service',
            left('Cleared after inspection, work order ' || v_wo.number, 500), auth.uid());
    update public.work_orders set restricted_truck = false where id = p_wo;
    perform private.wo_event(v_wo.company_id, p_wo, 'returned_to_service', null, null,
      'Trailer ' || v_trailer.unit_number || ' returned to service.');
    return true;
  end if;
  select * into v_truck from public.trucks where id = v_wo.truck_id and company_id = v_wo.company_id for update;
  if v_truck.service_status <> 'out_of_service' then
    update public.work_orders set restricted_truck = false where id = p_wo;
    return false;
  end if;
  select string_agg(w.number, ', ' order by w.created_at, w.number) into v_left from public.work_orders w
  where w.company_id = v_wo.company_id and w.truck_id = v_wo.truck_id and w.id <> p_wo
    and w.safety_critical and w.status not in ('completed', 'closed', 'canceled');
  if v_left is not null then
    update public.work_orders set restricted_truck = true
    where company_id = v_wo.company_id and truck_id = v_wo.truck_id and id <> p_wo
      and safety_critical and status not in ('completed', 'closed', 'canceled') and not restricted_truck;
    update public.work_orders set restricted_truck = false where id = p_wo;
    update public.trucks set out_of_service_reason = private.wo_hold_reason(v_wo.company_id, v_truck.id, null)
    where id = v_truck.id;
    perform private.wo_event(v_wo.company_id, p_wo, 'restricted', null, null,
      'Truck ' || v_truck.unit_number || ' stays out of service until ' ||
      case when position(',' in v_left) > 0 then 'work orders ' else 'work order ' end || v_left ||
      case when position(',' in v_left) > 0 then ' are' else ' is' end || ' cleared.');
    return false;
  end if;
  update public.trucks set service_status = 'in_service', out_of_service_reason = '', out_of_service_since = null,
    expected_return_date = null
  where id = v_truck.id;
  insert into public.equipment_status_events (company_id, truck_id, from_status, to_status, reason, actor_id)
  values (v_wo.company_id, v_truck.id, 'out_of_service', 'in_service',
          left('Cleared after inspection, work order ' || v_wo.number, 500), auth.uid());
  update public.work_orders set restricted_truck = false where id = p_wo;
  perform private.wo_event(v_wo.company_id, p_wo, 'returned_to_service', null, null,
    'Truck ' || v_truck.unit_number || ' returned to service.');
  return true;
end;
$function$;

-- One-time repair: units still out of service, held by an order that is no longer open, with open safety-critical
-- orders left. The hold moves to the open orders and the reason names them.
do $$
declare
  r record;
begin
  for r in
    select distinct w.company_id, w.truck_id, w.trailer_id
    from public.work_orders w
    where w.restricted_truck and w.status in ('completed', 'closed', 'canceled')
      and exists (select 1 from public.work_orders o
                  where o.company_id = w.company_id and o.safety_critical and o.status not in ('completed', 'closed', 'canceled')
                    and ((w.truck_id is not null and o.truck_id = w.truck_id) or (w.trailer_id is not null and o.trailer_id = w.trailer_id)))
  loop
    if r.truck_id is not null and exists (select 1 from public.trucks t where t.id = r.truck_id and t.service_status = 'out_of_service') then
      update public.work_orders set restricted_truck = (status not in ('completed', 'closed', 'canceled') and safety_critical)
      where company_id = r.company_id and truck_id = r.truck_id
        and (restricted_truck or (safety_critical and status not in ('completed', 'closed', 'canceled')));
      update public.trucks set out_of_service_reason = private.wo_hold_reason(r.company_id, r.truck_id, null)
      where id = r.truck_id;
    elsif r.trailer_id is not null and exists (select 1 from public.trailers t where t.id = r.trailer_id and t.service_status = 'out_of_service') then
      update public.work_orders set restricted_truck = (status not in ('completed', 'closed', 'canceled') and safety_critical)
      where company_id = r.company_id and trailer_id = r.trailer_id
        and (restricted_truck or (safety_critical and status not in ('completed', 'closed', 'canceled')));
      update public.trailers set out_of_service_reason = private.wo_hold_reason(r.company_id, null, r.trailer_id)
      where id = r.trailer_id;
    end if;
  end loop;
end;
$$;
