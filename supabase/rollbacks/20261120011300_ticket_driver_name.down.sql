-- Rollback of 20261120011300_ticket_driver_name: private.prepare_ticket returns to its 20261120008600 definition (the
-- profile name first). Tickets saved meanwhile keep their snapshot.
begin;
CREATE OR REPLACE FUNCTION private.prepare_ticket(p_company uuid, p_payload jsonb, p_except_number text, p_fallback_assignment uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_load       public.order_loads%rowtype;
  v_order      public.orders%rowtype;
  v_assignment public.dispatch_assignments%rowtype;
  v_line       public.order_lines%rowtype;
  v_truck      public.trucks%rowtype;
  v_trailer    public.trailers%rowtype;
  v_driver_id  uuid;
  v_driver     text;
  v_customer   text;
  v_tz         text := private.business_timezone(p_company);
  v_date       date := nullif(p_payload ->> 'delivered_date', '')::date;
  v_time       time := nullif(p_payload ->> 'delivered_time', '')::time;
  v_at         timestamptz;
  v_qty_text   text := trim(coalesce(p_payload ->> 'quantity', ''));
  v_qty        numeric;
  v_unit       text := nullif(trim(coalesce(p_payload ->> 'unit_code', '')), '');
  v_ref        text := private.clean_text(p_payload ->> 'external_reference', 60, 'Ticket reference');
  v_reasons    text[] := '{}';
  v_confirm    boolean := coalesce((p_payload ->> 'confirm_duplicate')::boolean, false);
  v_trailer_id uuid := nullif(p_payload ->> 'trailer_id', '')::uuid;
  v_dupes      text;
begin
  select * into v_load from public.order_loads
  where id = nullif(p_payload ->> 'load_id', '')::uuid and company_id = p_company for update;
  if not found then raise exception 'Load not found.'; end if;
  if v_load.status = 'canceled' then
    raise exception 'Load % is canceled. Tickets can only be entered for planned loads.', v_load.load_number;
  end if;
  select * into v_order from public.orders where id = v_load.order_id;
  if v_order.status not in ('scheduled', 'dispatched', 'in_progress', 'partially_completed', 'completed') then
    raise exception 'Order % is %. Tickets can be entered for scheduled, dispatched, in-progress or completed orders.',
      v_order.order_number, replace(v_order.status::text, '_', ' ');
  end if;
  select * into v_assignment from public.dispatch_assignments where load_id = v_load.id and status = 'active';
  if not found and p_fallback_assignment is not null then
    select * into v_assignment from public.dispatch_assignments
    where id = p_fallback_assignment and load_id = v_load.id and company_id = p_company;
  end if;
  if not found then
    raise exception '% load % has no truck and driver assigned. Assign it on the dispatch board first.',
      v_order.order_number, v_load.load_number;
  end if;

  -- Order line delivered (gives the material); must be a per-unit line of this order.
  select * into v_line from public.order_lines
  where id = nullif(p_payload ->> 'order_line_id', '')::uuid and company_id = p_company and order_id = v_order.id;
  if not found then raise exception 'Choose the order line that was delivered.'; end if;
  if v_line.calc_method <> 'per_unit' or v_line.kind = 'discount' then
    raise exception 'Choose a material or hauling line measured in units.';
  end if;

  -- Actual quantity and unit: required, never defaulted, never converted.
  if v_qty_text = '' then raise exception 'Enter the delivered quantity.'; end if;
  if v_qty_text !~ '^\d{1,6}(\.\d{1,3})?$' then
    raise exception 'Delivered quantity must be a number greater than 0 with at most 3 decimal places.';
  end if;
  v_qty := v_qty_text::numeric;
  if v_qty <= 0 then raise exception 'Delivered quantity must be greater than 0.'; end if;
  if v_unit is null then raise exception 'Choose the unit of the delivered quantity.'; end if;
  if not exists (select 1 from public.units_of_measure where company_id = p_company and code = v_unit) then
    raise exception 'Choose a valid unit.';
  end if;
  if private.unit_requires_whole(v_unit) and v_qty <> trunc(v_qty) then
    raise exception 'Quantities in % must be whole numbers.', v_unit;
  end if;

  -- Delivery time (local business time).
  if v_date is null or v_time is null then raise exception 'Enter the delivery date and time.'; end if;
  v_at := (v_date + v_time) at time zone v_tz;
  if v_at > now() + interval '1 hour' then raise exception 'The delivery time cannot be in the future.'; end if;
  if v_at < now() - interval '1 year' then raise exception 'The delivery time is more than a year ago.'; end if;

  -- Equipment and driver: from the assignment unless the paper ticket shows otherwise.
  select * into v_truck from public.trucks
  where id = coalesce(nullif(p_payload ->> 'truck_id', '')::uuid, v_assignment.truck_id) and company_id = p_company;
  if not found then raise exception 'Truck not found.'; end if;
  if p_payload ? 'trailer_id' then
    if v_trailer_id is not null then
      select * into v_trailer from public.trailers where id = v_trailer_id and company_id = p_company;
      if not found then raise exception 'Trailer not found.'; end if;
    end if;
  else
    v_trailer_id := v_assignment.trailer_id;
    if v_trailer_id is not null then
      select * into v_trailer from public.trailers where id = v_trailer_id;
    end if;
  end if;
  v_driver_id := coalesce(nullif(p_payload ->> 'driver_id', '')::uuid, v_assignment.driver_id);
  select coalesce(nullif(trim(p.full_name), ''), nullif(d.name, ''), 'Unnamed driver') into v_driver
  from public.drivers d left join public.profiles p on p.id = d.user_id
  where d.id = v_driver_id and d.company_id = p_company;
  if v_driver is null then raise exception 'Driver not found.'; end if;
  select name into v_customer from public.customers where id = v_order.customer_id;

  -- Review reasons (never conversions; the office decides).
  if v_line.unit_code is distinct from v_unit then
    v_reasons := v_reasons || 'unit_differs_from_order_line'::text;
  end if;
  if (v_at at time zone v_tz)::date <> v_load.load_date then
    v_reasons := v_reasons || 'delivered_on_other_day'::text;
  end if;
  if (v_truck.id, v_trailer_id, v_driver_id) is distinct from
     (v_assignment.truck_id, v_assignment.trailer_id, v_assignment.driver_id) then
    v_reasons := v_reasons || 'equipment_differs_from_assignment'::text;
  end if;
  -- Company setting: some companies' tickets carry no paper/scale number.
  if v_ref = '' and coalesce((select s.ticket_reference_required from public.company_settings s where s.company_id = p_company), true) then
    v_reasons := v_reasons || 'missing_external_reference'::text;
  end if;

  -- Possible duplicates need an explicit confirmation and are flagged.
  select string_agg(ticket_number, ', ' order by ticket_number) into v_dupes
  from public.delivery_tickets
  where company_id = p_company and load_id = v_load.id and status not in ('voided', 'superseded')
    and ticket_number is distinct from p_except_number;
  -- Truck-day slots (UX11) carry one ticket per trip: several tickets on one slot are the normal case, not a duplicate.
  if v_order.job_type = 'truck_day' then
    v_dupes := null;
  end if;
  if v_dupes is not null then
    if not v_confirm then
      raise exception '% load % already has ticket %. Confirm that this is a separate delivery to add another.',
        v_order.order_number, v_load.load_number, v_dupes using errcode = 'PT422';
    end if;
    v_reasons := v_reasons || 'additional_ticket_for_load'::text;
  end if;
  if v_ref <> '' then
    select string_agg(ticket_number, ', ' order by ticket_number) into v_dupes
    from public.delivery_tickets
    where company_id = p_company and lower(external_reference) = lower(v_ref)
      and status not in ('voided', 'superseded') and ticket_number is distinct from p_except_number;
    if v_dupes is not null then
      if not v_confirm then
        raise exception 'Ticket reference % is already used on %. Confirm to record it again.', v_ref, v_dupes
          using errcode = 'PT422';
      end if;
      v_reasons := v_reasons || 'duplicate_external_reference'::text;
    end if;
  end if;

  return jsonb_build_object(
    'order_id', v_order.id,
    'order_number', v_order.order_number,
    'load_id', v_load.id,
    'assignment_id', v_assignment.id,
    'order_line_id', v_line.id,
    'material_id', v_line.material_id,
    'truck_id', v_truck.id,
    'trailer_id', v_trailer_id,
    'driver_id', v_driver_id,
    'delivered_at', v_at,
    'quantity', v_qty,
    'unit_code', v_unit,
    'external_reference', v_ref,
    'notes', private.clean_text(p_payload ->> 'notes', 2000, 'Notes'),
    'review_reasons', to_jsonb(v_reasons),
    'snapshot', jsonb_build_object(
      'order_number', v_order.order_number,
      'load_number', v_load.load_number,
      'load_date', v_load.load_date,
      'customer_name', v_customer,
      'line_description', v_line.description,
      'line_unit_code', v_line.unit_code,
      'truck_unit', v_truck.unit_number,
      'trailer_unit', v_trailer.unit_number,
      'driver_name', v_driver,
      'planned_quantity', v_load.planned_quantity,
      'planned_unit_code', v_load.unit_code));
end;
$function$;
commit;
