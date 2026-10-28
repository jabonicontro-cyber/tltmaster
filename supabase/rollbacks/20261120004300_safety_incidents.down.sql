-- Rollback for 20261120004300_safety_incidents.sql: functions, tables, permissions. Stored photos stay in the
-- safety-photos bucket (remove them from storage separately if the data is not needed).
drop function if exists public.demo_safety_samples();
drop function if exists public.my_safety_reports();
drop function if exists public.safety_photo_path(uuid);
drop function if exists public.safety_photo_begin(uuid, text, integer);
drop function if exists public.safety_close(uuid, text);
drop function if exists public.safety_complete_action(uuid, text);
drop function if exists public.safety_add_action(uuid, text, uuid, date);
drop function if exists public.safety_add_witness(uuid, text, text, text);
drop function if exists public.safety_investigate(uuid, jsonb);
drop function if exists public.safety_report(jsonb);
drop function if exists private.safety_log(uuid, uuid, text, text);
drop function if exists private.safety_incident_for_manage(uuid);
drop table if exists public.safety_incident_events;
drop table if exists public.safety_incident_photos;
drop table if exists public.safety_incident_actions;
drop table if exists public.safety_incident_witnesses;
drop table if exists public.safety_incidents;
delete from public.role_permissions where permission in ('safety.view', 'safety.manage');
delete from public.role_permission_defaults where permission in ('safety.view', 'safety.manage');
delete from public.permissions where code in ('safety.view', 'safety.manage');
