-- =============================================================================
-- The office's to-do for an inspection certificate the shop recorded (owner decision 2026-11-09, MD1, SEC3).
--
-- 20261120015200 marks a certificate the mechanic records from the inspection work order (vehicle_documents.
-- work_order_id) and shows it as "Not checked yet" until a fleet.edit person verifies it. The to-do now also goes
-- through the existing operational alerts (20261105000300), the same way expiring vehicle documents do:
--   * alert type documents.certificate_check ("Inspection certificate from the shop needs checking"; documents;
--     Action required by default, Informational at the lowest; one recipient's acknowledgment is enough). Companies can
--     change its priority or turn it off in alert settings, like the other document alerts.
--   * private.certificate_check_alert (trigger on vehicle_documents): when such a certificate needs checking (recorded,
--     or recorded again, or changed so it lost its verification), the people with fleet.edit get the alert, linked to
--     the truck's or trailer's page (recipients as for the expiring-document alerts, private.comm_document_alerts).
--     When it is verified or archived, the alert is resolved ("Checked" / "Archived"). Acknowledging is not resolving:
--     the alert stays open until a person marks the certificate checked.
--   * Certificates already waiting for a check get their alert now.
-- Inside Taviron only (alerts and in-app notices); nothing is sent by email or text. The certificate keeps counting.
-- Additive; works with the code before and after it.
-- Reversible: supabase/rollbacks/20261120015700_certificate_check_alert.down.sql
-- =============================================================================

insert into public.alert_event_types (code, category, label, min_priority, default_priority, default_ack_scope, default_escalation_minutes) values
  ('documents.certificate_check', 'documents', 'Inspection certificate from the shop needs checking', 'informational', 'action_required', 'any', 1440)
on conflict (code) do nothing;

-- Raise the to-do for one certificate that needs checking (no-op when the company turned the type off).
create or replace function private.raise_certificate_check(p_doc public.vehicle_documents)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_unit   text;
  v_label  text;
  v_wo     text;
begin
  if p_doc.truck_id is not null then
    select 'truck ' || unit_number into v_unit from public.trucks where id = p_doc.truck_id and company_id = p_doc.company_id;
  else
    select 'trailer ' || unit_number into v_unit from public.trailers where id = p_doc.trailer_id and company_id = p_doc.company_id;
  end if;
  v_label := coalesce(v_unit, 'a vehicle');
  select number into v_wo from public.work_orders where id = p_doc.work_order_id and company_id = p_doc.company_id;
  return private.comm_raise_alert(p_doc.company_id, 'documents.certificate_check', p_doc.id::text, 'vehicle_document', p_doc.id,
    'Check the inspection certificate of ' || v_label,
    left(concat_ws(' ',
      'The shop recorded it' || coalesce(' from work order ' || v_wo, '') || ':',
      nullif(concat_ws(', ',
        case when p_doc.issued_on is not null then 'inspected ' || to_char(p_doc.issued_on, 'Mon FMDD, YYYY') end,
        'by ' || nullif(p_doc.issuing_authority, ''),
        case when p_doc.expires_on is not null then 'expires ' || to_char(p_doc.expires_on, 'Mon FMDD, YYYY') end), '') || '.',
      'It counts already. Compare it with the paper certificate, then mark it checked on the vehicle''s page.'), 1000),
    '/fleet/' || case when p_doc.truck_id is not null then 'trucks/' || p_doc.truck_id else 'trailers/' || p_doc.trailer_id end,
    private.alert_users_with(p_doc.company_id, array['fleet.edit']));
end;
$$;
revoke all on function private.raise_certificate_check(public.vehicle_documents) from public, anon, authenticated;

create or replace function private.certificate_check_alert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_needs     boolean := new.work_order_id is not null and new.verified_at is null and new.archived_at is null;
  v_needed    boolean := false;
begin
  if tg_op = 'UPDATE' then
    v_needed := old.work_order_id is not null and old.verified_at is null and old.archived_at is null;
  end if;
  if v_needs and not v_needed then
    perform private.raise_certificate_check(new);
  elsif v_needed and not v_needs then
    perform private.comm_resolve_alert(new.company_id, 'documents.certificate_check', new.id::text,
      case when new.verified_at is not null then 'Checked' else 'Archived' end);
  end if;
  return null;
end;
$$;
revoke all on function private.certificate_check_alert() from public, anon, authenticated;

drop trigger if exists vehicle_documents_certificate_check on public.vehicle_documents;
-- Every update, not only "update of verified_at": an edit clears verified_at in a BEFORE trigger
-- (private.unverify_changed_document), which an "update of" column list would not see.
create trigger vehicle_documents_certificate_check after insert or update
  on public.vehicle_documents for each row execute function private.certificate_check_alert();

-- Certificates already waiting for a check.
select private.raise_certificate_check(d)
from public.vehicle_documents d
where d.work_order_id is not null and d.verified_at is null and d.archived_at is null
  and not exists (select 1 from public.alerts a where a.company_id = d.company_id and a.event_type = 'documents.certificate_check'
                  and a.source_key = d.id::text and a.status = 'open');
