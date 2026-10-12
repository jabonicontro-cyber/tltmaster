-- Reverses supabase/migrations/20261105000300_operational_alerts.sql.
-- NOT a migration: run by hand, only after a backup and only if the founder asks.
-- Alerts, their recipients, acknowledgments and history are deleted. Notifications
-- already delivered (public.comm_notifications) stay. Workspace archiving and
-- housekeeping return to their 20261105000200 versions.
begin;
drop trigger if exists alerts_work_orders on public.work_orders;
drop trigger if exists alerts_field_reports on public.field_reports;
drop trigger if exists alerts_assignments on public.dispatch_assignments;
drop trigger if exists alerts_time_off on public.time_off_requests;
drop trigger if exists alerts_announcements on public.announcements;
drop trigger if exists alerts_announcement_receipts on public.announcement_receipts;

-- 20261105000200 versions (no alert veto; no escalation or document checks).
create or replace function private.comm_operation_can_archive(p_conversation uuid)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select true
$$;

create or replace function public.comm_housekeeping()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v_last timestamptz;
begin
  perform pg_advisory_xact_lock(hashtext('comm_housekeeping:' || v_company::text));
  select ran_at into v_last from public.comm_housekeeping_runs where company_id = v_company;
  if v_last is not null and v_last > now() - interval '1 minute' then return jsonb_build_object('skipped', true); end if;
  insert into public.comm_housekeeping_runs (company_id, ran_at) values (v_company, now())
  on conflict (company_id) do update set ran_at = now();
  return jsonb_build_object('archived', private.comm_archive_finished(v_company), 'retention', private.comm_apply_retention(v_company));
end;
$$;

drop table if exists public.alert_events;
drop table if exists public.alert_acknowledgments;
drop table if exists public.alert_recipients;
drop table if exists public.alerts;

drop function if exists public.comm_alert_counts();
drop function if exists private.alerts_from_announcement_receipts();
drop function if exists private.alerts_from_announcements();
drop function if exists private.alerts_from_time_off();
drop function if exists private.alerts_from_assignments();
drop function if exists private.alerts_from_field_reports();
drop function if exists private.alerts_from_work_orders();
drop function if exists private.comm_document_alerts(uuid);
drop function if exists private.comm_escalate_due(uuid);
drop function if exists public.comm_save_alert_setting(text, jsonb);
drop function if exists public.comm_alert_resolve(uuid, text);
drop function if exists public.comm_alert_reassign(uuid, uuid, uuid, text);
drop function if exists public.comm_alert_set_priority(uuid, text, text);
drop function if exists public.comm_alert_acknowledge(uuid, text);
drop function if exists private.comm_resolve_alert(uuid, text, text, text);
drop function if exists private.comm_raise_alert(uuid, text, text, text, uuid, text, text, text, uuid[], text);
drop function if exists private.alert_outstanding(uuid);
drop function if exists private.alert_users_with(uuid, text[]);
drop function if exists private.alert_policy(uuid, text);
drop function if exists private.alert_is_recipient(uuid);
drop table if exists public.comm_alert_settings;
drop table if exists public.alert_event_types;
drop function if exists private.alert_rank(text);
commit;
