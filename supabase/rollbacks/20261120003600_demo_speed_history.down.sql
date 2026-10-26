-- Rollback of 20261120003600_demo_speed_history.sql (not a migration; run by hand with a backup first).
-- Restores the three guards exactly as before and removes the demo timing function. Demo times already moved stay as
-- they are (fictional demo data; nothing else changed).
begin;
drop function if exists public.demo_speed_history();
CREATE OR REPLACE FUNCTION private.guard_dispatch_assignment()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  if tg_op = 'DELETE' then
    if current_setting('tlt.sample_purge', true) = 'on' then
      return old;
    end if;
    raise exception 'Dispatch assignments are history and cannot be deleted. Cancel them instead.' using errcode = '42501';
  end if;
  if old.status = 'canceled' then
    raise exception 'A canceled assignment cannot be changed.' using errcode = '42501';
  end if;
  if (new.load_id, new.order_id, new.truck_id, new.trailer_id, new.driver_id, new.created_by, new.created_at,
      new.replaces_assignment_id, new.warnings, new.note)
     is distinct from
     (old.load_id, old.order_id, old.truck_id, old.trailer_id, old.driver_id, old.created_by, old.created_at,
      old.replaces_assignment_id, old.warnings, old.note) then
    raise exception 'Assignments cannot be edited. Reassign the load instead.' using errcode = '42501';
  end if;
  return new;
end;
$function$

;
CREATE OR REPLACE FUNCTION private.guard_delivery_ticket()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  if tg_op = 'DELETE' then
    if current_setting('tlt.sample_purge', true) = 'on' then
      return old;
    end if;
    raise exception 'Delivery tickets cannot be deleted. Void them instead.' using errcode = '42501';
  end if;
  if (new.ticket_number, new.revision, new.supersedes_id, new.order_id, new.load_id, new.assignment_id,
      new.order_line_id, new.material_id, new.truck_id, new.trailer_id, new.driver_id, new.delivered_at,
      new.quantity, new.unit_code, new.external_reference, new.notes, new.review_reasons, new.snapshot,
      new.correction_reason, new.submission_key, new.created_by, new.created_at)
     is distinct from
     (old.ticket_number, old.revision, old.supersedes_id, old.order_id, old.load_id, old.assignment_id,
      old.order_line_id, old.material_id, old.truck_id, old.trailer_id, old.driver_id, old.delivered_at,
      old.quantity, old.unit_code, old.external_reference, old.notes, old.review_reasons, old.snapshot,
      old.correction_reason, old.submission_key, old.created_by, old.created_at) then
    raise exception 'A submitted ticket cannot be edited. Use a correction.' using errcode = '42501';
  end if;
  if new.status is distinct from old.status and not (
       (old.status in ('submitted', 'needs_review') and new.status in ('accepted', 'needs_review', 'voided', 'superseded'))
    or (old.status = 'accepted' and new.status in ('needs_review', 'voided', 'superseded'))) then
    raise exception 'A % ticket cannot become %.', old.status, new.status using errcode = '42501';
  end if;
  return new;
end;
$function$

;
CREATE OR REPLACE FUNCTION private.prevent_modification()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  if tg_op = 'DELETE'
     and current_setting('tlt.sample_purge', true) = 'on'
     and tg_table_name in ('quote_status_events', 'email_deliveries', 'documents', 'order_status_events',
                           'delivery_ticket_events', 'billing_reviews', 'portal_messages') then
    return old;
  end if;
  raise exception '% rows are append-only and cannot be changed or deleted.', tg_table_name
    using errcode = '42501';
end;
$function$

;
drop function if exists private.demo_timing_allowed(uuid);
commit;
