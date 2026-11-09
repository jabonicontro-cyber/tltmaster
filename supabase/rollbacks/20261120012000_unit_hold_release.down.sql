-- Rollback of 20261120012000_unit_hold_release: restores private.wo_restrict_truck and private.wo_release_truck exactly
-- as 20261120007200 defined them and removes private.wo_hold_reason. Functions only. Hold marks moved by the
-- migration's one-time repair stay where they are (they name open safety-critical orders, which the old functions
-- also understand).

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
            left('Cleared after inspection, work order ' || v_wo.number, 500), auth.uid());
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
          left('Cleared after inspection, work order ' || v_wo.number, 500), auth.uid());
  update public.work_orders set restricted_truck = false where id = p_wo;
  perform private.wo_event(v_wo.company_id, p_wo, 'returned_to_service', null, null,
    'Truck ' || v_truck.unit_number || ' returned to service.');
  return true;
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
  else
    perform private.wo_event(v_wo.company_id, p_wo, 'restricted', null, null,
      'Truck ' || v_truck.unit_number || ' was already out of service; it stays restricted until this work order is cleared.');
  end if;
end;
$function$;

drop function private.wo_hold_reason(uuid, uuid, uuid);
