-- No em dashes in what the database writes or says (owner 2026-11-04/05, approved database change 2026-11-05).
-- 1. Thirteen functions get the same wording as the app: messages raised to people, the dispatch eligibility messages (the app's copy in src/lib/dispatch must match
--    them word for word, tests/db/dispatch.test.ts), and titles they write (inspection work orders "Pre-trip inspection
--    defect: truck 101", truck restriction reasons, the demo samples). Bodies are otherwise unchanged.
-- 2. Demo companies only (companies.is_demo): em dashes already saved in their text records are rewritten
--    (" — " becomes ": "). Never a real company. Rows a guard refuses to change (locked or issued records) are left as
--    they are. Not reversed by the rollback (fictional demo data).
-- save_quote_draft keeps its text (its body deletes draft lines, which the hosted workflow would stop on); the app
-- already shows database messages without em dashes (dbErrorMessage).
-- Reversible (functions): supabase/rollbacks/20261120007200_plain_dashes.down.sql.

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
    when 'truck_shop_work_open' then 'Truck has shop work in progress or waiting for parts. Check with the shop.'
    when 'trailer_safety_restricted' then 'Trailer has an open safety-critical work order. It returns to service only after an authorized inspection clears it.'
    when 'trailer_shop_scheduled' then 'Trailer is scheduled in the shop on this date.'
    when 'trailer_shop_work_open' then 'Trailer has shop work in progress or waiting for parts. Check with the shop.'
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
      || coalesce((select ' ' || string_agg(format('%s %s: %s expired %s. Record the renewed document in Fleet, or change the company rule in Settings.',
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

CREATE OR REPLACE FUNCTION private.create_ticket(p_company uuid, p_payload jsonb, p_source text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_key     uuid := nullif(p_payload ->> 'submission_key', '')::uuid;
  v_t       public.delivery_tickets%rowtype;
  v_p       jsonb;
  v_status  public.ticket_status;
begin
  if v_key is not null then
    select * into v_t from public.delivery_tickets where company_id = p_company and submission_key = v_key;
    if found then
      return jsonb_build_object('ticket_id', v_t.id, 'ticket_number', v_t.ticket_number, 'status', v_t.status, 'created', false);
    end if;
  end if;

  v_p := private.prepare_ticket(p_company, p_payload, null);
  v_status := case when jsonb_array_length(v_p -> 'review_reasons') > 0 then 'needs_review' else 'submitted' end;

  insert into public.delivery_tickets (
    company_id, ticket_number, revision, status, order_id, load_id, assignment_id, order_line_id, material_id,
    truck_id, trailer_id, driver_id, delivered_at, quantity, unit_code, external_reference, notes, review_reasons,
    snapshot, submission_key, created_by)
  values (
    p_company, private.next_document_number(p_company, 'ticket'), 1, v_status,
    (v_p ->> 'order_id')::uuid, (v_p ->> 'load_id')::uuid, (v_p ->> 'assignment_id')::uuid,
    (v_p ->> 'order_line_id')::uuid, nullif(v_p ->> 'material_id', '')::uuid,
    (v_p ->> 'truck_id')::uuid, nullif(v_p ->> 'trailer_id', '')::uuid, (v_p ->> 'driver_id')::uuid,
    (v_p ->> 'delivered_at')::timestamptz, (v_p ->> 'quantity')::numeric, v_p ->> 'unit_code',
    v_p ->> 'external_reference', v_p ->> 'notes',
    array(select jsonb_array_elements_text(v_p -> 'review_reasons')), v_p -> 'snapshot', v_key, auth.uid())
  returning * into v_t;

  insert into public.delivery_ticket_events (company_id, ticket_id, ticket_number, action, from_status, to_status, note, details, actor_id)
  values (p_company, v_t.id, v_t.ticket_number, 'submitted', null, v_t.status, '',
          jsonb_build_object('review_reasons', to_jsonb(v_t.review_reasons))
            || case when p_source <> 'office' then jsonb_build_object('source', p_source) else '{}'::jsonb end,
          auth.uid());
  perform private.log_event('ticket.submitted', 'order', v_t.order_id,
    format('Ticket %s for %s load %s: %s %s%s%s', v_t.ticket_number, v_p -> 'snapshot' ->> 'order_number',
           v_p -> 'snapshot' ->> 'load_number', trim_scale(v_t.quantity), v_t.unit_code,
           case when v_t.status = 'needs_review' then ' (needs review)' else '' end,
           case when p_source = 'driver_portal' then ', entered by the driver' else '' end),
    jsonb_build_object('ticket_id', v_t.id, 'ticket_number', v_t.ticket_number, 'load_id', v_t.load_id)
      || case when p_source <> 'office' then jsonb_build_object('source', p_source) else '{}'::jsonb end);

  return jsonb_build_object('ticket_id', v_t.id, 'ticket_number', v_t.ticket_number, 'status', v_t.status, 'created', true);
end;
$function$;

CREATE OR REPLACE FUNCTION public.update_order_urgency(p_urgency_id uuid, p_state urgency_state, p_note text DEFAULT ''::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_company uuid;
  v_note    text := private.clean_text(p_note, 500, 'Note');
  v_u       public.order_urgencies%rowtype;
  v_from    public.urgency_state;
  v_number  text;
begin
  v_company := private.require_company();
  if p_state = 'awaiting_acknowledgement' then
    raise exception 'An urgent flag cannot go back to awaiting acknowledgement.' using errcode = '22023';
  end if;
  if p_state = 'canceled' then
    perform private.require_permission('orders.edit');
  elsif p_state = 'resolved' then
    if not (private.has_permission('dispatch.edit') or private.has_permission('orders.edit')) then
      raise exception 'You do not have permission to resolve urgent orders.' using errcode = '42501';
    end if;
  else
    perform private.require_permission('dispatch.edit');
  end if;
  if p_state in ('blocked', 'waiting_for_information', 'resolved', 'canceled') and v_note = '' then
    raise exception 'Add a note: what is blocking, what is missing, or how it was resolved.' using errcode = '22023';
  end if;

  select * into v_u from public.order_urgencies where id = p_urgency_id and company_id = v_company for update;
  if not found then raise exception 'Urgent flag not found.' using errcode = 'P0002'; end if;
  if v_u.closed_at is not null then
    raise exception 'This urgent flag is already %.', v_u.state using errcode = 'PT409';
  end if;
  if v_u.state = p_state and v_u.state_note = v_note then
    return jsonb_build_object('urgency_id', v_u.id, 'state', v_u.state, 'changed', false);
  end if;
  if p_state = 'assigned' and not exists (
       select 1 from public.dispatch_assignments a
       join public.order_loads l on l.id = a.load_id and l.company_id = a.company_id
       where a.company_id = v_company and l.order_id = v_u.order_id and a.status = 'active' and l.status = 'planned') then
    raise exception 'No truck is assigned to this order yet. Assign one on the dispatch board first.' using errcode = '22023';
  end if;

  v_from := v_u.state;
  update public.order_urgencies
     set state = p_state, state_note = v_note, state_changed_by = auth.uid(), state_changed_at = now(),
         acknowledged_by = coalesce(acknowledged_by, case when p_state not in ('resolved', 'canceled') or v_from <> 'awaiting_acknowledgement' then auth.uid() end),
         acknowledged_at = coalesce(acknowledged_at, case when p_state not in ('resolved', 'canceled') or v_from <> 'awaiting_acknowledgement' then now() end),
         closed_at = case when p_state in ('resolved', 'canceled') then now() end
   where id = v_u.id
  returning * into v_u;
  perform private.urgency_event(v_u, 'state_changed', v_from, v_note);
  select order_number into v_number from public.orders where id = v_u.order_id and company_id = v_company;
  perform private.log_event('order.urgent_' || p_state::text, 'order', v_u.order_id,
    format('%s urgent: %s%s', v_number, replace(p_state::text, '_', ' '), case when v_note <> '' then ': ' || v_note else '' end),
    jsonb_build_object('urgency_id', v_u.id, 'from', v_from, 'to', p_state));
  return jsonb_build_object('urgency_id', v_u.id, 'state', v_u.state, 'changed', true);
end;
$function$;

CREATE OR REPLACE FUNCTION private.guard_work_order_cost()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_status text;
begin
  select status into v_status from public.work_orders
  where id = coalesce(new.work_order_id, old.work_order_id);
  if v_status in ('closed', 'canceled') then
    raise exception 'This work order is %. Its costs can no longer be changed.', v_status using errcode = 'P0001';
  end if;
  return coalesce(new, old);
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

CREATE OR REPLACE FUNCTION public.comm_send(p_conversation uuid, p_body text, p_reply_to uuid DEFAULT NULL::uuid, p_client_key uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_company uuid := private.require_company();
  v public.conversations%rowtype;
  v_body text := trim(coalesce(p_body, ''));
  v_id uuid;
  v_at timestamptz;
  v_parent public.messages%rowtype;
  r record;
  v_cat text;
  v_title text;
begin
  perform private.require_permission('comms.message');
  if p_client_key is not null then
    select id, created_at into v_id, v_at from public.messages where company_id = v_company and author_id = auth.uid() and client_key = p_client_key;
    if found then return jsonb_build_object('id', v_id, 'created_at', v_at, 'duplicate', true); end if;
  end if;
  select * into v from public.conversations where id = p_conversation and company_id = v_company;
  if not found then raise exception 'Conversation not found.' using errcode = 'P0002'; end if;
  if private.comm_active_member(p_conversation) is null then
    raise exception 'You are not a current member of this conversation.' using errcode = '42501';
  end if;
  if v.status <> 'active' then raise exception 'This conversation is %. Reopen it to post.', v.status using errcode = 'P0001'; end if;
  if length(v_body) = 0 then raise exception 'Write a message.' using errcode = 'P0001'; end if;
  if length(v_body) > 4000 then raise exception 'A message can be at most 4000 characters.' using errcode = 'P0001'; end if;
  if p_reply_to is not null then
    select * into v_parent from public.messages where id = p_reply_to and conversation_id = p_conversation;
    if not found or not private.comm_message_visible(p_conversation, v_parent.created_at, v_parent.pinned) then
      raise exception 'The message you reply to was not found.' using errcode = 'P0002';
    end if;
    if v_parent.reply_to_id is not null then p_reply_to := v_parent.reply_to_id; end if; -- one level of threads
  end if;
  insert into public.messages (company_id, conversation_id, author_id, kind, body, reply_to_id, client_key)
  values (v_company, p_conversation, auth.uid(), 'text', v_body, p_reply_to, p_client_key)
  returning id, created_at into v_id, v_at;
  update public.conversations set last_message_at = v_at where id = p_conversation;
  update public.conversation_members set last_read_at = v_at, last_delivered_at = v_at
  where conversation_id = p_conversation and user_id = auth.uid() and left_at is null;

  v_cat := case v.kind when 'direct' then 'direct' when 'channel' then 'channel' else 'group' end;
  v_title := case v.kind when 'direct' then 'New message from ' || private.comm_user_name(auth.uid())
                         else 'New message in ' || coalesce(nullif(v.title, ''), 'a group conversation') end;
  for r in select m.user_id, m.muted_until from public.conversation_members m
           where m.conversation_id = p_conversation and m.left_at is null and m.user_id <> auth.uid() loop
    if r.muted_until is null or r.muted_until <= now() then
      perform private.comm_notify(v_company, r.user_id, v_cat, v_title, '/communications/c/' || p_conversation, p_conversation, v_id);
    end if;
  end loop;
  return jsonb_build_object('id', v_id, 'created_at', v_at, 'duplicate', false);
exception
  when unique_violation then
    select id, created_at into v_id, v_at from public.messages where company_id = v_company and author_id = auth.uid() and client_key = p_client_key;
    if found then return jsonb_build_object('id', v_id, 'created_at', v_at, 'duplicate', true); end if;
    raise;
end;
$function$;

CREATE OR REPLACE FUNCTION private.alerts_from_field_reports()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if tg_op = 'INSERT' and new.kind in ('breakdown', 'inspection_issue') then
    perform private.comm_raise_alert(new.company_id, 'dispatch.breakdown_report', new.id::text, 'load', new.load_id,
      case when new.kind = 'breakdown' then 'Breakdown reported' else 'Inspection problem reported' end ||
        coalesce(', truck ' || (new.snapshot ->> 'truck_unit'), ''),
      coalesce(new.snapshot ->> 'order_number', '') || ' load ' || coalesce(new.snapshot ->> 'load_number', ''),
      '/field-reports/' || new.id, private.alert_users_with(new.company_id, array['comms.alerts', 'field_reports.manage']));
  elsif tg_op = 'UPDATE' and new.status = 'resolved' and old.status <> 'resolved' then
    perform private.comm_resolve_alert(new.company_id, 'dispatch.breakdown_report', new.id::text, 'Report resolved: ' || new.resolution_note);
  end if;
  return null;
end;
$function$;

CREATE OR REPLACE FUNCTION public.comm_begin_attachment(p_conversation uuid, p_upload_key uuid, p_file_name text, p_mime text, p_size integer, p_sha256 text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_company uuid := private.require_company();
  v public.conversations%rowtype;
  r public.message_attachments%rowtype;
  v_id uuid := gen_random_uuid();
  v_name text := left(regexp_replace(trim(coalesce(p_file_name, '')), '[\x00-\x1f/\\]', '_', 'g'), 200);
begin
  perform private.require_permission('comms.message');
  if p_upload_key is null then raise exception 'Missing upload key.' using errcode = 'P0001'; end if;
  select * into r from public.message_attachments where company_id = v_company and upload_key = p_upload_key;
  if found then
    if r.created_by is distinct from auth.uid() then raise exception 'This upload was already used.' using errcode = '42501'; end if;
    return jsonb_build_object('attachment_id', r.id, 'object_path', r.object_path, 'status', r.status);
  end if;
  select * into v from public.conversations where id = p_conversation and company_id = v_company;
  if not found then raise exception 'Conversation not found.' using errcode = 'P0002'; end if;
  if private.comm_active_member(p_conversation) is null then
    raise exception 'You are not a current member of this conversation.' using errcode = '42501';
  end if;
  if v.status <> 'active' then raise exception 'This conversation is %. Reopen it to post.', v.status using errcode = 'P0001'; end if;
  if p_mime is null or p_mime not in ('image/jpeg', 'image/png', 'image/webp', 'application/pdf') then
    raise exception 'Only JPEG, PNG, WebP images or PDF files can be attached.' using errcode = 'P0001';
  end if;
  if p_size is null or p_size < 1 or p_size > 10485760 then raise exception 'A file must be 10 MB or smaller.' using errcode = 'P0001'; end if;
  if p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$' then raise exception 'Invalid file checksum.' using errcode = 'P0001'; end if;
  if length(v_name) = 0 then v_name := 'file'; end if;
  if (select count(*) from public.message_attachments where company_id = v_company and created_by = auth.uid()
      and status in ('pending', 'uploaded') and created_at > now() - interval '1 day') >= 20 then
    raise exception 'Too many files are waiting to be sent. Send or remove them first.' using errcode = 'P0001';
  end if;
  insert into public.message_attachments (id, company_id, conversation_id, object_path, file_name, mime_type, size_bytes, sha256, upload_key, created_by)
  values (v_id, v_company, p_conversation,
          v_company || '/comm-attachments/' || v_id || case p_mime when 'image/jpeg' then '.jpg' when 'image/png' then '.png'
                                                                   when 'image/webp' then '.webp' else '.pdf' end,
          v_name, p_mime, p_size, p_sha256, p_upload_key, auth.uid())
  returning * into r;
  return jsonb_build_object('attachment_id', r.id, 'object_path', r.object_path, 'status', r.status);
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

CREATE OR REPLACE FUNCTION public.onboarding_demo_samples()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_company uuid := private.require_company();
  v_added integer;
  v_staff uuid;
begin
  perform private.require_permission('settings.manage');
  if not exists (select 1 from public.companies where id = v_company and is_demo) then
    raise exception 'Sample onboarding is only for demo companies.' using errcode = '42501';
  end if;
  if exists (select 1 from public.onboarding_tasks where company_id = v_company) then return 0; end if;
  v_added := private.onboarding_generate(v_company, '{"routing": false, "ai": false}'::jsonb);
  -- A fictional mid-onboarding picture: finished, waiting on review, changes requested, blocked, waiting on the customer.
  update public.onboarding_tasks set status = 'approved', decided_at = now() - interval '6 days'
    where company_id = v_company and key in ('agreement', 'company_profile', 'people');
  update public.onboarding_tasks set status = 'approved', decided_at = now() - interval '2 days'
    where company_id = v_company and key = 'materials';
  update public.onboarding_tasks set status = 'submitted', submitted_at = now() - interval '1 day'
    where company_id = v_company and key = 'customers';
  update public.onboarding_tasks set status = 'changes_requested', decided_at = now() - interval '1 day',
    status_note = 'Three trucks have no capacity yet (sample). Add weight or volume capacity and submit again.'
    where company_id = v_company and key = 'trucks';
  update public.onboarding_tasks set status = 'blocked',
    status_note = 'Waiting for medical card copies from two drivers (sample).', due_on = private.company_today(v_company) - 2
    where company_id = v_company and key = 'drivers';
  update public.onboarding_tasks set status = 'awaiting_customer', status_note = 'Pick two dates for the session (sample).',
    due_on = private.company_today(v_company) + 5
    where company_id = v_company and key = 'training_dispatch';
  update public.onboarding_tasks set status = 'not_applicable', status_note = 'Demo company: no portal setup needed (sample).'
    where company_id = v_company and key = 'portal' and not required;
  insert into public.onboarding_events (company_id, task_id, actor, actor_side, kind, from_status, to_status, body)
  select company_id, id, null, 'system', 'status', 'not_started', status, 'Sample state for the demo company.'
  from public.onboarding_tasks where company_id = v_company and status <> 'not_started';
  insert into public.onboarding_events (company_id, task_id, actor, actor_side, kind, body)
  select company_id, id, null, 'taviron', 'comment', 'Thanks, the materials file looked good. We imported 12 materials after your review (sample).'
  from public.onboarding_tasks where company_id = v_company and key = 'materials';
  return v_added;
end;
$function$;

CREATE OR REPLACE FUNCTION public.inspection_submit(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_company uuid := private.require_company();
  v_truck uuid := nullif(p ->> 'truck_id', '')::uuid;
  v_today date := private.company_today(v_company);
  v_day date;
  v_expected integer;
  v_kind text := p ->> 'kind';
  v_items jsonb := coalesce(p -> 'items', '[]'::jsonb);
  v_driver uuid;
  v_defects jsonb;
  v_safety boolean;
  v_unit text;
  v_id uuid;
  v_wo_id uuid;
  v_number text;
begin
  -- Saved on the phone without signal and sent later (B133): the day it was done, today or yesterday only.
  v_day := coalesce(nullif(p ->> 'inspected_on', '')::date, v_today);
  if v_day not in (v_today, v_today - 1) then
    raise exception 'An inspection can be sent for today or yesterday only.' using errcode = '22023';
  end if;
  v_driver := private.fuel_writer(v_company, v_truck, v_day);
  select count(*) into v_expected from private.inspection_items_for(v_truck);
  if v_kind not in ('pre_trip', 'post_trip') then
    raise exception 'Choose pre-trip or post-trip.' using errcode = '22023';
  end if;
  if jsonb_typeof(v_items) <> 'array'
     or jsonb_array_length(v_items) <> v_expected
     or (select count(distinct e ->> 'key') from jsonb_array_elements(v_items) e where (e ->> 'key') in (select key from private.inspection_items_for(v_truck))) <> v_expected
     or exists (select 1 from jsonb_array_elements(v_items) e where jsonb_typeof(e -> 'ok') is distinct from 'boolean') then
    raise exception 'Check every item.' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(v_items) e where not (e ->> 'ok')::boolean and length(trim(coalesce(e ->> 'note', ''))) < 3) then
    raise exception 'Describe each defect.' using errcode = '22023';
  end if;
  if exists (select 1 from public.vehicle_inspections where truck_id = v_truck and inspected_on = v_day and kind = v_kind) then
    raise exception 'This truck already has a % inspection for that day.', replace(v_kind, '_', '-') using errcode = '23505';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('key', e ->> 'key', 'note', left(trim(e ->> 'note'), 300), 'safety', i.safety)), '[]'::jsonb),
         coalesce(bool_or(i.safety), false)
    into v_defects, v_safety
  from jsonb_array_elements(v_items) e join private.inspection_items_for(v_truck) i on i.key = e ->> 'key'
  where not (e ->> 'ok')::boolean;
  insert into public.vehicle_inspections (company_id, truck_id, driver_id, kind, inspected_on, odometer, items, defect_count, safety_defect, remarks, created_by)
  values (v_company, v_truck, v_driver, v_kind, v_day, nullif(p ->> 'odometer', '')::integer,
          (select jsonb_agg(jsonb_build_object('key', e ->> 'key', 'ok', (e ->> 'ok')::boolean, 'note', left(trim(coalesce(e ->> 'note', '')), 300))) from jsonb_array_elements(v_items) e),
          jsonb_array_length(v_defects), v_safety, private.clean_text(p ->> 'remarks', 1000, 'Remarks'), auth.uid())
  returning id into v_id;

  if jsonb_array_length(v_defects) > 0 then
    select unit_number into v_unit from public.trucks where id = v_truck;
    v_number := private.next_document_number(v_company, 'work_order');
    insert into public.work_orders (company_id, number, truck_id, driver_id, title, description, category, urgency, safety_critical, status, source, created_by)
    values (v_company, v_number, v_truck, v_driver,
            left(format('%s inspection defect%s: truck %s', case v_kind when 'pre_trip' then 'Pre-trip' else 'Post-trip' end, case when jsonb_array_length(v_defects) > 1 then 's' else '' end, v_unit), 120),
            left((select string_agg(format('%s: %s', replace(d ->> 'key', '_', ' '), d ->> 'note'), E'\n') from jsonb_array_elements(v_defects) d), 4000),
            'inspection', case when v_safety then 'immediate' else 'normal' end, v_safety, 'reported', 'inspection', auth.uid())
    returning id into v_wo_id;
    perform private.wo_event(v_company, v_wo_id, 'created', null, 'reported', 'From a driver inspection');
    if v_safety then
      perform private.wo_restrict_truck(v_wo_id);
    end if;
    update public.vehicle_inspections set work_order_id = v_wo_id where id = v_id;
  end if;
  perform private.log_event('inspection.submitted', 'vehicle_inspection', v_id,
    format('%s inspection: %s defect(s)', replace(v_kind, '_', '-'), jsonb_array_length(v_defects)), jsonb_build_object('work_order', v_number));
  return jsonb_build_object('id', v_id, 'defects', jsonb_array_length(v_defects), 'safety', v_safety, 'work_order', v_number);
exception
  when invalid_text_representation or numeric_value_out_of_range then
    raise exception 'Check the odometer and the day.' using errcode = '22023';
end;
$function$;

CREATE OR REPLACE FUNCTION public.demo_inspection_samples()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_demo uuid := private.demo_owner_company();
  v_today date;
  v_day date;
  v_truck record;
  v_items jsonb;
  v_n integer := 0;
  v_i integer;
  v_wo uuid;
begin
  if v_demo is null then
    raise exception 'Demo samples are only added to a demo company, by its owner.' using errcode = '42501';
  end if;
  if exists (select 1 from public.vehicle_inspections where company_id = v_demo) then
    return 0;
  end if;
  v_today := private.company_today(v_demo);
  v_items := (select jsonb_agg(jsonb_build_object('key', key, 'ok', true, 'note', '')) from private.inspection_items());
  for v_truck in select id, unit_number from public.trucks where company_id = v_demo and active and hauler_id is null and service_status = 'in_service' order by unit_number limit 4 loop
    for v_i in 1..6 loop
      v_day := v_today - v_i;
      continue when extract(isodow from v_day) > 5;
      insert into public.vehicle_inspections (company_id, truck_id, kind, inspected_on, items, created_by)
      values (v_demo, v_truck.id, 'pre_trip', v_day, v_items, auth.uid())
      on conflict do nothing;
      v_n := v_n + 1;
    end loop;
  end loop;
  -- One minor defect yesterday-ish on the first truck: a work order, the truck stays in service.
  select id into v_truck from public.trucks where company_id = v_demo and active and hauler_id is null and service_status = 'in_service' order by unit_number limit 1;
  if found then
    v_day := v_today - 1;
    while extract(isodow from v_day) > 5 loop v_day := v_day - 1; end loop;
    insert into public.work_orders (company_id, number, truck_id, title, description, category, urgency, safety_critical, status, source, estimated_hours, created_by)
    values (v_demo, private.next_document_number(v_demo, 'work_order'), v_truck.id, 'Post-trip inspection defect: wipers (demo)', 'wipers: Driver-side blade streaking (demo)', 'inspection', 'normal', false, 'reported', 'inspection', 0.5, auth.uid())
    returning id into v_wo;
    insert into public.vehicle_inspections (company_id, truck_id, kind, inspected_on, items, defect_count, safety_defect, work_order_id, created_by)
    values (v_demo, v_truck.id, 'post_trip', v_day,
            (select jsonb_agg(jsonb_build_object('key', key, 'ok', key <> 'wipers', 'note', case when key = 'wipers' then 'Driver-side blade streaking (demo)' else '' end)) from private.inspection_items()),
            1, false, v_wo, auth.uid())
    on conflict do nothing;
    v_n := v_n + 1;
  end if;
  return v_n;
end;
$function$;

-- 2. Demo companies' saved text.
do $$
declare
  c record;
  n bigint;
begin
  for c in
    select col.table_name, col.column_name
      from information_schema.columns col
      join information_schema.columns cid on cid.table_schema = col.table_schema and cid.table_name = col.table_name and cid.column_name = 'company_id'
      join information_schema.tables t on t.table_schema = col.table_schema and t.table_name = col.table_name and t.table_type = 'BASE TABLE'
     where col.table_schema = 'public' and col.data_type in ('text', 'character varying') and col.column_name <> 'company_id'
  loop
    begin
      execute format(
        'update public.%I set %I = replace(replace(%I, '' — '', '': ''), ''—'', ''-'') where %I like ''%%—%%'' and company_id in (select id from public.companies where is_demo)',
        c.table_name, c.column_name, c.column_name, c.column_name);
    exception when others then
      -- A guard (locked, issued or append-only record) refused: leave that table's text as it is.
      null;
    end;
  end loop;
end;
$$;
