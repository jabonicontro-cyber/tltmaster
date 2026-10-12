-- =============================================================================
-- Communications attachments: private files on messages.
--
-- Same model as ticket photos (20261019000100):
--   * One private Supabase Storage bucket, `comm-attachments`. Object paths are
--     <company_id>/comm-attachments/<attachment_id>.<ext>, chosen by the database.
--   * public.message_attachments records each file: pending (path reserved) →
--     uploaded (size and type confirmed against the stored object) → attached
--     (to a message, in the same transaction as the message) or discarded.
--   * Storage RLS lets a user insert an object only at the exact path of their
--     own pending attachment, and read only attachments of messages they may
--     read (the conversation's history rules, not deleted). No update or delete
--     for app users. There are never public URLs: the app route checks access
--     on every request and redirects to a 60-second signed URL.
--   * Allowed: JPEG, PNG, WebP and PDF up to 10 MB; at most 5 files per message.
--   * Messages removed by retention take their attachment rows with them; the
--     objects are then listed by public.abandoned_comm_attachments() for the
--     service-role cleanup (no app user can delete files).
--   * The storage parts run only when the storage schema exists; otherwise run
--     `select private.setup_comm_attachment_storage();` after enabling it.
--
-- Depends on 20261105000100 (conversations, messages, comm_send) and
-- 20261105000200 (the workspace posting guard applies through comm_send).
-- Rollback: supabase/rollbacks/20261105000400_comm_attachments.down.sql
-- =============================================================================

create table public.message_attachments (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies (id),
  conversation_id uuid not null,
  message_id      uuid,
  status          text not null default 'pending' check (status in ('pending', 'uploaded', 'attached', 'discarded')),
  object_path     text not null unique check (object_path ~ '^[0-9a-f-]{36}/comm-attachments/[0-9a-f-]{36}\.(jpg|png|webp|pdf)$'),
  file_name       text not null check (length(trim(file_name)) between 1 and 200),
  mime_type       text not null check (mime_type in ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')),
  size_bytes      integer not null check (size_bytes between 1 and 10485760),
  sha256          text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  upload_key      uuid not null,
  created_by      uuid references auth.users (id) on delete set null,
  created_at      timestamptz not null default now(),
  uploaded_at     timestamptz,
  attached_at     timestamptz,
  unique (company_id, upload_key),
  constraint message_attachments_path_company check (split_part(object_path, '/', 1) = company_id::text),
  constraint message_attachments_conversation_fk foreign key (company_id, conversation_id)
    references public.conversations (company_id, id) on delete cascade,
  constraint message_attachments_message_fk foreign key (message_id) references public.messages (id) on delete cascade,
  constraint message_attachments_state check (
    (status = 'pending' and uploaded_at is null and message_id is null)
    or (status = 'uploaded' and uploaded_at is not null and message_id is null)
    or (status = 'attached' and uploaded_at is not null and message_id is not null and attached_at is not null)
    or (status = 'discarded' and message_id is null))
);
create index message_attachments_message_idx on public.message_attachments (message_id) where status = 'attached';
create index message_attachments_open_idx on public.message_attachments (company_id, status, created_at) where status in ('pending', 'uploaded');

create trigger a_company_guard before update of company_id on public.message_attachments
  for each row execute function private.forbid_company_change();

/** May the caller read this attachment row (and its file)? The message's own visibility rules decide. */
create or replace function private.comm_attachment_readable(p_attachment uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.message_attachments a
    join public.messages m on m.id = a.message_id
    where a.id = p_attachment and a.status = 'attached' and a.company_id = private.current_company_id()
      and m.deleted_at is null
      and private.comm_message_visible(m.conversation_id, m.created_at, m.pinned))
$$;

alter table public.message_attachments enable row level security;
create policy message_attachments_read on public.message_attachments for select to authenticated
  using (company_id = (select private.current_company_id()) and private.comm_attachment_readable(id));
revoke all on public.message_attachments from anon, authenticated;
grant select on public.message_attachments to authenticated;
grant all on public.message_attachments to service_role;

-- -----------------------------------------------------------------------------
-- Storage authorization (used by the storage.objects policies)
-- -----------------------------------------------------------------------------
create or replace function private.can_upload_comm_attachment(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.message_attachments a
    where a.object_path = p_name and a.status = 'pending' and a.created_by = auth.uid()
      and a.company_id = private.current_company_id() and split_part(p_name, '/', 1) = a.company_id::text)
$$;

create or replace function private.can_read_comm_attachment(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.message_attachments a where a.object_path = p_name and private.comm_attachment_readable(a.id))
$$;

create or replace function private.setup_comm_attachment_storage()
returns void
language plpgsql
set search_path = ''
as $$
begin
  if to_regclass('storage.objects') is null or to_regclass('storage.buckets') is null then
    raise exception 'Supabase Storage is not installed in this database.';
  end if;
  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('comm-attachments', 'comm-attachments', false, 10485760, array['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
  on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
  drop policy if exists comm_attachments_insert on storage.objects;
  drop policy if exists comm_attachments_read on storage.objects;
  create policy comm_attachments_insert on storage.objects for insert to authenticated
    with check (bucket_id = 'comm-attachments' and private.can_upload_comm_attachment(name));
  create policy comm_attachments_read on storage.objects for select to authenticated
    using (bucket_id = 'comm-attachments' and private.can_read_comm_attachment(name));
  -- No update or delete policies: app users never replace or remove a file.
end;
$$;

grant execute on function private.can_upload_comm_attachment(text), private.can_read_comm_attachment(text) to authenticated;

do $$
begin
  if to_regclass('storage.objects') is not null then
    perform private.setup_comm_attachment_storage();
  else
    raise notice 'Supabase Storage is not installed: run select private.setup_comm_attachment_storage(); after enabling it.';
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- Upload steps
-- -----------------------------------------------------------------------------
/** Reserve a path for a file in a conversation the caller may post in. Idempotent per upload key. */
create or replace function public.comm_begin_attachment(p_conversation uuid, p_upload_key uuid, p_file_name text, p_mime text, p_size integer, p_sha256 text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
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
  if v.status <> 'active' then raise exception 'This conversation is % — reopen it to post.', v.status using errcode = 'P0001'; end if;
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
$$;

/** After the upload: the stored object must match what was declared. */
create or replace function public.comm_confirm_attachment(p_attachment uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  r public.message_attachments%rowtype;
  v_size bigint;
  v_mime text;
begin
  select * into r from public.message_attachments where id = p_attachment and company_id = v_company and created_by = auth.uid() for update;
  if not found then raise exception 'File not found.' using errcode = 'P0002'; end if;
  if r.status in ('uploaded', 'attached') then return jsonb_build_object('attachment_id', r.id, 'status', r.status); end if;
  if r.status <> 'pending' then raise exception 'This file was removed. Add it again.' using errcode = 'P0001'; end if;
  select (o.metadata ->> 'size')::bigint, o.metadata ->> 'mimetype' into v_size, v_mime
  from storage.objects o where o.bucket_id = 'comm-attachments' and o.name = r.object_path;
  if not found then raise exception 'The file did not arrive. Try again.' using errcode = 'P0001'; end if;
  if v_size is distinct from r.size_bytes or v_mime is distinct from r.mime_type then
    raise exception 'The stored file does not match what was sent. Try again.' using errcode = 'P0001';
  end if;
  update public.message_attachments set status = 'uploaded', uploaded_at = now() where id = r.id;
  return jsonb_build_object('attachment_id', r.id, 'status', 'uploaded');
end;
$$;

/** Discard a file the caller added but has not sent. */
create or replace function public.comm_discard_attachment(p_attachment uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.message_attachments set status = 'discarded'
  where id = p_attachment and company_id = private.require_company() and created_by = auth.uid() and status in ('pending', 'uploaded');
end;
$$;

/**
 * Send a message with files (same rules and idempotency as comm_send). The files
 * must be the caller's own confirmed uploads for this conversation. With no text,
 * the message says which files were shared.
 */
create or replace function public.comm_send_files(p_conversation uuid, p_body text, p_reply_to uuid, p_client_key uuid, p_attachments uuid[])
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v_ids uuid[] := coalesce((select array_agg(distinct x) from unnest(p_attachments) x where x is not null), '{}');
  v_body text := trim(coalesce(p_body, ''));
  v_res jsonb;
  v_n integer;
begin
  if cardinality(v_ids) = 0 then return public.comm_send(p_conversation, p_body, p_reply_to, p_client_key); end if;
  if cardinality(v_ids) > 5 then raise exception 'At most 5 files per message.' using errcode = 'P0001'; end if;
  if length(v_body) = 0 then
    select 'Shared ' || case when count(*) = 1 then 'a file: ' || min(file_name) else count(*) || ' files' end into v_body
    from public.message_attachments where id = any (v_ids) and company_id = v_company;
  end if;
  v_res := public.comm_send(p_conversation, v_body, p_reply_to, p_client_key);
  if (v_res ->> 'duplicate')::boolean then return v_res; end if;
  perform 1 from public.message_attachments
  where id = any (v_ids) and company_id = v_company and created_by = auth.uid() and conversation_id = p_conversation and status = 'uploaded'
  for update;
  get diagnostics v_n = row_count;
  if v_n <> cardinality(v_ids) then
    raise exception 'A file is not ready (still uploading, or not yours). Wait for the upload or remove the file.' using errcode = 'P0001';
  end if;
  update public.message_attachments set status = 'attached', message_id = (v_res ->> 'id')::uuid, attached_at = now() where id = any (v_ids);
  return v_res || jsonb_build_object('attachments', cardinality(v_ids));
end;
$$;

-- Service role: files whose upload was never sent, and stored objects without a live record.
create or replace function public.abandoned_comm_attachments(p_hours integer default 24)
returns table (attachment_id uuid, object_path text, reason text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  return query
  select a.id, a.object_path, 'not sent within ' || greatest(p_hours, 1) || ' hours'
  from public.message_attachments a
  where a.status in ('pending', 'uploaded', 'discarded') and a.created_at < now() - make_interval(hours => greatest(p_hours, 1))
  union all
  select null::uuid, o.name, 'no attachment record'
  from storage.objects o
  where o.bucket_id = 'comm-attachments'
    and not exists (select 1 from public.message_attachments a where a.object_path = o.name);
end;
$$;

revoke execute on function public.abandoned_comm_attachments(integer) from public, anon, authenticated;
grant execute on function public.abandoned_comm_attachments(integer) to service_role;
revoke execute on function private.setup_comm_attachment_storage() from public, anon, authenticated;

do $$
declare f text;
begin
  foreach f in array array['public.comm_begin_attachment(uuid, uuid, text, text, integer, text)', 'public.comm_confirm_attachment(uuid)',
    'public.comm_discard_attachment(uuid)', 'public.comm_send_files(uuid, text, uuid, uuid, uuid[])'] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end;
$$;
