-- Rollback of 20261120001000_guided_onboarding.
-- DESTRUCTIVE for onboarding data: drops every onboarding checklist, its history and the document records. Take a
-- backup first (pg_dump -Fc). Files already stored in the `onboarding-documents` bucket are NOT deleted here (Storage
-- objects are removed only through the Storage API); list them before rolling back if they must go too.
-- In-app notifications already created with category 'onboarding' are removed so the original category check fits.
drop function if exists public.onboarding_demo_samples();
drop function if exists public.onboarding_confirm_document(uuid);
drop function if exists public.onboarding_begin_document(uuid, uuid, text, text, integer, text);
drop function if exists public.onboarding_document_path(uuid);
drop function if exists public.platform_onboarding_import_staged(uuid, uuid);
drop function if exists public.platform_onboarding_remind(uuid);
drop function if exists public.platform_onboarding_comment(uuid, text, boolean);
drop function if exists public.platform_onboarding_set_status(uuid, text, text);
drop function if exists public.platform_onboarding_overview();
drop function if exists public.platform_onboarding(uuid);
drop function if exists public.platform_onboarding_generate(uuid, jsonb);
drop function if exists public.onboarding_assign(uuid, uuid, date);
drop function if exists public.onboarding_comment(uuid, text);
drop function if exists public.onboarding_set_status(uuid, text, text);
drop function if exists public.onboarding_state();

do $$
begin
  if to_regclass('storage.objects') is not null then
    drop policy if exists onboarding_documents_insert on storage.objects;
    drop policy if exists onboarding_documents_read on storage.objects;
  end if;
end;
$$;
drop function if exists private.setup_onboarding_document_storage();
drop function if exists private.can_read_onboarding_document(text);
drop function if exists private.can_upload_onboarding_document(text);
drop function if exists private.onboarding_change(uuid, text, text, boolean);
drop function if exists private.onboarding_generate(uuid, jsonb);
drop function if exists private.onboarding_json(uuid, boolean);
drop function if exists private.onboarding_summary(uuid);
drop function if exists private.onboarding_notify(public.onboarding_tasks, text);
drop function if exists private.onboarding_unmet(public.onboarding_tasks);
drop function if exists private.onboarding_customer(uuid);
drop function if exists private.onboarding_staff();

drop table if exists public.onboarding_documents;
drop table if exists public.onboarding_events;
drop table if exists public.onboarding_tasks;
drop function if exists private.onboarding_events_append_only();

delete from public.comm_notifications where category = 'onboarding';
alter table public.comm_notifications drop constraint comm_notifications_category_check;
alter table public.comm_notifications add constraint comm_notifications_category_check
  check (category in ('direct', 'group', 'channel', 'announcement', 'alert', 'catch_up', 'membership'));
