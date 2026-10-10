-- =============================================================================
-- Delivery ticket processing (N11)
--
-- 1. Company setting `ticket_reference_required`: whether a ticket without a
--    paper/scale ticket number is flagged for review (default true = previous
--    behavior for every existing company).
-- 2. Office scans/photos of paper tickets: someone with tickets.edit attaches an
--    image to a live ticket (same private bucket, same storage policies: the
--    caller's own reserved path in their own company). Reserve → upload →
--    confirm-and-attach; idempotent per upload key; recorded in the ticket
--    history ("photo_added"). The image is never replaced or deleted.
-- 3. `verified_delivery_inputs`: the accepted (verified) current revision of
--    each ticket with its driver, truck, load and quantity — the documented
--    input for future payroll calculations. No money, no pay rules; readable
--    with tickets.view (RLS of the underlying tables applies).
--
-- Additive: no existing rows change.
-- =============================================================================

alter table public.company_settings
  add column ticket_reference_required boolean not null default true;
comment on column public.company_settings.ticket_reference_required is
  'Flag tickets without a paper/scale ticket number for review (true) or accept them without one (false).';
grant update (ticket_reference_required) on public.company_settings to authenticated;

create or replace function private.prepare_ticket(p_company uuid, p_payload jsonb, p_except_number text, p_fallback_assignment uuid DEFAULT NULL::uuid)
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

-- -----------------------------------------------------------------------------
-- Office scans/photos
-- -----------------------------------------------------------------------------
alter table public.delivery_ticket_events drop constraint delivery_ticket_events_action_check;
alter table public.delivery_ticket_events add constraint delivery_ticket_events_action_check
  check (action in ('submitted', 'flagged', 'accepted', 'voided', 'corrected', 'photo_added'));

/** Reserve a storage path for a scan/photo of a live ticket (tickets.edit). Repeating with the same key returns the same reservation. */
create or replace function public.begin_ticket_scan(p_ticket_id uuid, p_upload_key uuid, p_mime text, p_size integer, p_sha256 text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid;
  v_t       public.delivery_tickets%rowtype;
  v_r       public.ticket_attachments%rowtype;
  v_id      uuid := gen_random_uuid();
begin
  perform private.require_permission('tickets.edit');
  v_company := private.require_company();
  if p_upload_key is null then raise exception 'Missing upload key.'; end if;
  select * into v_r from public.ticket_attachments where company_id = v_company and upload_key = p_upload_key;
  if found then
    if v_r.created_by is distinct from auth.uid() then raise exception 'This upload was already used.' using errcode = '42501'; end if;
    return jsonb_build_object('attachment_id', v_r.id, 'object_path', v_r.object_path, 'status', v_r.status);
  end if;
  if p_mime is null or p_mime not in ('image/jpeg', 'image/png', 'image/webp') then
    raise exception 'Only JPEG, PNG or WebP images can be attached.';
  end if;
  if p_size is null or p_size < 1 or p_size > 5242880 then raise exception 'The image must be 5 MB or smaller.'; end if;
  if p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$' then raise exception 'Invalid file checksum.'; end if;

  select * into v_t from public.delivery_tickets where id = p_ticket_id and company_id = v_company;
  if not found then raise exception 'Ticket not found.' using errcode = 'P0002'; end if;
  if v_t.status in ('voided', 'superseded') then
    raise exception 'Ticket % revision % is %; add the image to the current revision.', v_t.ticket_number, v_t.revision, v_t.status;
  end if;
  if (select count(*) from public.ticket_attachments
      where company_id = v_company and status <> 'discarded'
        and (ticket_number = v_t.ticket_number or (status in ('pending', 'uploaded') and load_id = v_t.load_id and created_by = auth.uid()))) >= 6 then
    raise exception 'A ticket can have at most 6 images.';
  end if;

  insert into public.ticket_attachments (id, company_id, object_path, mime_type, size_bytes, sha256, upload_key,
                                         assignment_id, load_id, order_id, created_by)
  values (v_id, v_company,
          v_company || '/ticket-photos/' || v_id || case p_mime when 'image/jpeg' then '.jpg' when 'image/png' then '.png' else '.webp' end,
          p_mime, p_size, p_sha256, p_upload_key, v_t.assignment_id, v_t.load_id, v_t.order_id, auth.uid())
  returning * into v_r;
  return jsonb_build_object('attachment_id', v_r.id, 'object_path', v_r.object_path, 'status', v_r.status);
end;
$$;

/**
 * Confirm the stored object matches the reservation and attach it to the ticket
 * (the current revision at this moment). Safe to repeat; never re-attaches.
 */
create or replace function public.attach_ticket_scan(p_attachment_id uuid, p_ticket_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid;
  v_r       public.ticket_attachments%rowtype;
  v_t       public.delivery_tickets%rowtype;
  v_size    bigint;
  v_mime    text;
begin
  perform private.require_permission('tickets.edit');
  v_company := private.require_company();
  select * into v_r from public.ticket_attachments
  where id = p_attachment_id and company_id = v_company and created_by = auth.uid() for update;
  if not found then raise exception 'Image not found.' using errcode = '42501'; end if;
  if v_r.status = 'attached' then
    return jsonb_build_object('attachment_id', v_r.id, 'status', v_r.status, 'ticket_id', v_r.ticket_id);
  end if;
  if v_r.status = 'discarded' then raise exception 'This upload was discarded. Add the image again.'; end if;

  select * into v_t from public.delivery_tickets where id = p_ticket_id and company_id = v_company for update;
  if not found or v_t.load_id is distinct from v_r.load_id then
    raise exception 'Ticket not found.' using errcode = 'P0002';
  end if;
  if v_t.status in ('voided', 'superseded') then
    raise exception 'Ticket % changed while uploading (now %). Open the current revision and add the image again.', v_t.ticket_number, v_t.status
      using errcode = 'PT409';
  end if;

  select (o.metadata ->> 'size')::bigint, o.metadata ->> 'mimetype' into v_size, v_mime
  from storage.objects o where o.bucket_id = 'ticket-photos' and o.name = v_r.object_path;
  if not found then raise exception 'The image did not arrive. Try again.'; end if;
  if v_size is distinct from v_r.size_bytes or v_mime is distinct from v_r.mime_type then
    raise exception 'The stored image does not match what was sent. Try again.';
  end if;

  if v_r.status = 'pending' then
    update public.ticket_attachments set status = 'uploaded', uploaded_at = now() where id = v_r.id;
  end if;
  update public.ticket_attachments
     set status = 'attached', ticket_id = v_t.id, ticket_number = v_t.ticket_number, attached_at = now()
   where id = v_r.id;
  insert into public.delivery_ticket_events (company_id, ticket_id, ticket_number, action, from_status, to_status, note, details, actor_id)
  values (v_company, v_t.id, v_t.ticket_number, 'photo_added', v_t.status, v_t.status,
          'Scan or photo of the paper ticket added', jsonb_build_object('attachment_id', v_r.id, 'size_bytes', v_r.size_bytes), auth.uid());
  return jsonb_build_object('attachment_id', v_r.id, 'status', 'attached', 'ticket_id', v_t.id);
end;
$$;

revoke execute on function public.begin_ticket_scan(uuid, uuid, text, integer, text), public.attach_ticket_scan(uuid, uuid) from public, anon;
grant execute on function public.begin_ticket_scan(uuid, uuid, text, integer, text), public.attach_ticket_scan(uuid, uuid) to authenticated;
revoke execute on function private.prepare_ticket(uuid, jsonb, text, uuid) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Verified delivery facts (input for future payroll; no money)
-- -----------------------------------------------------------------------------
create view public.verified_delivery_inputs with (security_invoker = true) as
select t.company_id, t.id as ticket_id, t.ticket_number, t.revision, t.supersedes_id,
       t.order_id, t.load_id, t.assignment_id, t.order_line_id, t.material_id,
       t.driver_id, t.truck_id, t.trailer_id,
       t.delivered_at, t.quantity, t.unit_code, t.external_reference,
       t.reviewed_by as verified_by, t.reviewed_at as verified_at,
       l.load_date, l.start_time, l.end_time
from public.delivery_tickets t
join public.order_loads l on l.id = t.load_id and l.company_id = t.company_id
where t.status = 'accepted';
comment on view public.verified_delivery_inputs is
  'Verified (accepted, current-revision) deliveries with driver, truck, load and quantity. Input for future driver-pay calculations; contains no prices or pay.';
revoke all on public.verified_delivery_inputs from anon;
grant select on public.verified_delivery_inputs to authenticated;
