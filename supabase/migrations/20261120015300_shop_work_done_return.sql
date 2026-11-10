-- =============================================================================
-- Truck parked by hand: offer to put it back in service once its shop work is done (owner decision 2026-11-09, MD1).
--
-- Automatic safety holds return the unit by themselves when the last safety-critical order clears (20261120012000).
-- A truck or trailer a person took out of service is never returned automatically. Now, when its shop work is done,
-- the shop and dispatch are asked: "All shop work on truck 104 is done. Put it back in service?" with one tap.
--
--   public.units_back_from_shop()   (fleet.view) active trucks and trailers that are out of service, have no open work
--     order (reported to awaiting inspection), and had a work order completed or closed since they went out of service.
--     The caller's company and dispatch bases only. The last finished work order's number only for maintenance.view.
--   public.return_unit_after_shop(kind, id)   (fleet.service, fleet.edit or maintenance.manage) puts such a unit back
--     in service through the same steps as the fleet page's Return to service (private.apply_service_status: status,
--     status history, the clearance guard), records 'fleet.returned_after_shop' in the audit log, and refuses a unit
--     whose shop work is not done (or that is not out of service).
--   private.apply_service_status: the body of public.set_equipment_service_status after its permission check, now
--     shared; set_equipment_service_status checks fleet.service as before and calls it (same results, same messages).
-- Nothing returns by itself; nothing changes until a person taps the button.
-- Additive; works with the code before and after it.
-- Reversible: supabase/rollbacks/20261120015300_shop_work_done_return.down.sql
-- =============================================================================

create or replace function private.apply_service_status(p_company uuid, p_kind text, p_id uuid, p_status public.service_status,
  p_reason text, p_expected_return date)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reason  text := private.clean_text(p_reason, 500, 'Reason');
  v_unit    text;
  v_from    public.service_status;
begin
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
  if p_expected_return is not null and p_expected_return < private.business_today(p_company) then
    raise exception 'The expected return date cannot be in the past.';
  end if;

  if p_kind = 'truck' then
    select unit_number, service_status into v_unit, v_from
    from public.trucks where id = p_id and company_id = p_company for update;
  else
    select unit_number, service_status into v_unit, v_from
    from public.trailers where id = p_id and company_id = p_company for update;
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
  values (p_company,
          case when p_kind = 'truck' then p_id end,
          case when p_kind = 'trailer' then p_id end,
          v_from, p_status, v_reason, p_expected_return, auth.uid());

  return jsonb_build_object('id', p_id, 'service_status', p_status);
end;
$$;
revoke all on function private.apply_service_status(uuid, text, uuid, public.service_status, text, date) from public, anon, authenticated;

create or replace function public.set_equipment_service_status(p_kind text, p_id uuid, p_status public.service_status,
  p_reason text default '', p_expected_return date default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid;
begin
  perform private.require_permission('fleet.service');
  v_company := private.require_company();
  return private.apply_service_status(v_company, p_kind, p_id, p_status, p_reason, p_expected_return);
end;
$$;

-- Units out of service whose shop work is done (see the header). One row per unit.
create or replace function public.units_back_from_shop()
returns table (kind text, id uuid, unit_number text, out_of_service_reason text, out_of_service_since timestamptz,
  work_done_at timestamptz, work_order_id uuid, work_order_number text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v_bases   uuid[] := private.my_bases();
  v_shop    boolean := private.has_permission('maintenance.view');
begin
  perform private.require_permission('fleet.view');
  return query
  with units as (
    select 'truck'::text as kind, t.id, t.unit_number, t.out_of_service_reason, t.out_of_service_since, t.base_id
    from public.trucks t
    where t.company_id = v_company and t.active and t.service_status = 'out_of_service' and t.out_of_service_since is not null
    union all
    select 'trailer', l.id, l.unit_number, l.out_of_service_reason, l.out_of_service_since, l.base_id
    from public.trailers l
    where l.company_id = v_company and l.active and l.service_status = 'out_of_service' and l.out_of_service_since is not null
  )
  select u.kind, u.id, u.unit_number, u.out_of_service_reason, u.out_of_service_since, d.done_at,
         case when v_shop then d.wo_id end, case when v_shop then d.wo_number end
  from units u
  cross join lateral (
    select coalesce(w.completed_at, w.closed_at) as done_at, w.id as wo_id, w.number as wo_number
    from public.work_orders w
    where w.company_id = v_company
      and ((u.kind = 'truck' and w.truck_id = u.id) or (u.kind = 'trailer' and w.trailer_id = u.id))
      and w.status in ('completed', 'closed')
      and coalesce(w.completed_at, w.closed_at) >= u.out_of_service_since
    order by coalesce(w.completed_at, w.closed_at) desc
    limit 1
  ) d
  where (v_bases is null or u.base_id is null or u.base_id = any (v_bases))
    and not exists (
      select 1 from public.work_orders o
      where o.company_id = v_company
        and ((u.kind = 'truck' and o.truck_id = u.id) or (u.kind = 'trailer' and o.trailer_id = u.id))
        and o.status in ('reported', 'triaged', 'scheduled', 'in_progress', 'awaiting_parts', 'awaiting_inspection'))
  order by u.kind desc, u.unit_number;
end;
$$;

create or replace function public.return_unit_after_shop(p_kind text, p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v_unit    text;
  v_status  public.service_status;
  v_since   timestamptz;
  v_open    text;
  v_done    record;
  v_label   text := case p_kind when 'truck' then 'Truck' when 'trailer' then 'Trailer' end;
begin
  if not (private.has_permission('fleet.service') or private.has_permission('fleet.edit') or private.has_permission('maintenance.manage')) then
    raise exception 'You do not have permission to perform this action (fleet.edit or maintenance.manage).' using errcode = '42501';
  end if;
  if v_label is null then
    raise exception 'Unknown equipment kind.' using errcode = '22023';
  end if;
  if p_kind = 'truck' then
    select unit_number, service_status, out_of_service_since into v_unit, v_status, v_since
    from public.trucks where id = p_id and company_id = v_company and active for update;
  else
    select unit_number, service_status, out_of_service_since into v_unit, v_status, v_since
    from public.trailers where id = p_id and company_id = v_company and active for update;
  end if;
  if v_unit is null then
    raise exception 'Equipment not found.' using errcode = 'P0002';
  end if;
  if v_status <> 'out_of_service' then
    raise exception '% % is already in service.', v_label, v_unit using errcode = 'P0001';
  end if;
  select string_agg(o.number, ', ' order by o.number) into v_open from public.work_orders o
  where o.company_id = v_company and ((p_kind = 'truck' and o.truck_id = p_id) or (p_kind = 'trailer' and o.trailer_id = p_id))
    and o.status in ('reported', 'triaged', 'scheduled', 'in_progress', 'awaiting_parts', 'awaiting_inspection');
  if v_open is not null then
    raise exception 'Shop work is still open on % % (%). Put it back in service when that work is done.', lower(v_label), v_unit, v_open
      using errcode = 'P0001';
  end if;
  select w.id, w.number into v_done from public.work_orders w
  where w.company_id = v_company and ((p_kind = 'truck' and w.truck_id = p_id) or (p_kind = 'trailer' and w.trailer_id = p_id))
    and w.status in ('completed', 'closed') and v_since is not null and coalesce(w.completed_at, w.closed_at) >= v_since
  order by coalesce(w.completed_at, w.closed_at) desc limit 1;
  if v_done.id is null then
    raise exception 'No shop work was finished on % % since it went out of service. Return it to service from its fleet page if it is ready.', lower(v_label), v_unit
      using errcode = 'P0001';
  end if;

  perform private.apply_service_status(v_company, p_kind, p_id, 'in_service', 'All shop work done.', null);
  perform private.log_event('fleet.returned_after_shop', p_kind, p_id,
    format('%s %s put back in service: all shop work is done (last job %s).', v_label, v_unit, v_done.number),
    jsonb_build_object('work_order_id', v_done.id, 'work_order_number', v_done.number, 'out_of_service_since', v_since));
  return jsonb_build_object('id', p_id, 'kind', p_kind, 'unit_number', v_unit, 'service_status', 'in_service');
end;
$$;

revoke all on function public.units_back_from_shop(), public.return_unit_after_shop(text, uuid) from public, anon;
grant execute on function public.units_back_from_shop(), public.return_unit_after_shop(text, uuid) to authenticated;
