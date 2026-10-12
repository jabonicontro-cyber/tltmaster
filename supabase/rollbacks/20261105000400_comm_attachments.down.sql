-- Reverses supabase/migrations/20261105000400_comm_attachments.sql.
-- NOT a migration: run by hand, only after a backup and only if the founder asks.
-- Attachment records are deleted; messages stay. Stored objects in the
-- `comm-attachments` bucket are NOT removed here: list them first with
-- public.abandoned_comm_attachments() (before running this) and remove them
-- through the Storage API with the service role, then delete the bucket.
begin;
do $$
begin
  if to_regclass('storage.objects') is not null then
    drop policy if exists comm_attachments_insert on storage.objects;
    drop policy if exists comm_attachments_read on storage.objects;
  end if;
end;
$$;
drop table if exists public.message_attachments;
drop function if exists public.abandoned_comm_attachments(integer);
drop function if exists public.comm_send_files(uuid, text, uuid, uuid, uuid[]);
drop function if exists public.comm_discard_attachment(uuid);
drop function if exists public.comm_confirm_attachment(uuid);
drop function if exists public.comm_begin_attachment(uuid, uuid, text, text, integer, text);
drop function if exists private.setup_comm_attachment_storage();
drop function if exists private.can_read_comm_attachment(text);
drop function if exists private.can_upload_comm_attachment(text);
drop function if exists private.comm_attachment_readable(uuid);
commit;
