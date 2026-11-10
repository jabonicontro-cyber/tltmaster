-- Rollback of 20261120015300_shop_work_done_return: removes the "put it back in service" prompt functions and restores
-- public.set_equipment_service_status with its own body (as in 20261013000100, exactly). Units already put back in
-- service stay in service; their status history and audit entries stay.

drop function if exists public.return_unit_after_shop(text, uuid);
drop function if exists public.units_back_from_shop();

CREATE OR REPLACE FUNCTION public.set_equipment_service_status(p_kind text, p_id uuid, p_status service_status, p_reason text DEFAULT ''::text, p_expected_return date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_company uuid;
  v_reason  text := private.clean_text(p_reason, 500, 'Reason');
  v_unit    text;
  v_from    public.service_status;
begin
  perform private.require_permission('fleet.service');
  v_company := private.require_company();

  if p_kind not in ('truck', 'trailer') then
    raise exception 'Unknown equipment kind.';
  end if;
  if p_status is null then
    raise exception 'Choose a status.';
  end if;
  if p_status = 'out_of_service' and length(v_reason) = 0 then
    raise exception 'Enter a reason for taking the equipment out of service.';
  end if;
  if p_status = 'in_service' and p_expected_return is not null then
    raise exception 'An expected return date only applies to equipment that is out of service.';
  end if;
  if p_expected_return is not null and p_expected_return < private.business_today(v_company) then
    raise exception 'The expected return date cannot be in the past.';
  end if;

  if p_kind = 'truck' then
    select unit_number, service_status into v_unit, v_from
    from public.trucks where id = p_id and company_id = v_company for update;
  else
    select unit_number, service_status into v_unit, v_from
    from public.trailers where id = p_id and company_id = v_company for update;
  end if;
  if v_unit is null then
    raise exception 'Equipment not found.';
  end if;
  if v_from = p_status then
    raise exception '% % is already %.', initcap(p_kind), v_unit, replace(p_status::text, '_', ' ');
  end if;

  if p_kind = 'truck' then
    update public.trucks set
      service_status        = p_status,
      out_of_service_reason = case when p_status = 'out_of_service' then v_reason else '' end,
      out_of_service_since  = case when p_status = 'out_of_service' then now() end,
      expected_return_date  = p_expected_return
    where id = p_id;
  else
    update public.trailers set
      service_status        = p_status,
      out_of_service_reason = case when p_status = 'out_of_service' then v_reason else '' end,
      out_of_service_since  = case when p_status = 'out_of_service' then now() end,
      expected_return_date  = p_expected_return
    where id = p_id;
  end if;

  insert into public.equipment_status_events (company_id, truck_id, trailer_id, from_status, to_status, reason,
                                               expected_return_date, actor_id)
  values (v_company,
          case when p_kind = 'truck' then p_id end,
          case when p_kind = 'trailer' then p_id end,
          v_from, p_status, v_reason, p_expected_return, auth.uid());

  return jsonb_build_object('id', p_id, 'service_status', p_status);
end;
$function$;

drop function if exists private.apply_service_status(uuid, text, uuid, public.service_status, text, date);
