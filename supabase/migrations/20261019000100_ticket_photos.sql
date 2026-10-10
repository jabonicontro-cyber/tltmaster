-- =============================================================================
-- Secure file storage and delivery-ticket photos (N8.1).
--
-- Design (docs/IMPLEMENTATION_PLAN.md §5h):
--   * One private Supabase Storage bucket, `ticket-photos`. Object paths are
--     <company_id>/ticket-photos/<attachment_id>.<ext>, chosen by the database.
--   * ticket_attachments records every photo. Storage RLS lets a user insert an
--     object only when a pending attachment row with exactly that path exists
--     for them in their company, and read only attached photos of their company
--     with tickets.view. No update or delete for app users; the cleanup script
--     uses the service role through the Storage API.
--   * Photos are attached inside driver_submit_ticket (same transaction, same
--     idempotency). They belong to the ticket number and are kept through
--     corrections and voids.
--   * The storage parts run only when the storage schema exists; otherwise
--     run `select private.setup_ticket_photo_storage();` after enabling it.
-- Additive. To reverse: drop the storage policies and bucket created by
-- private.setup_ticket_photo_storage, the functions and triggers defined here
-- and the ticket_attachments table; restore driver_submit_ticket from
-- 20261018000100.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Attachment records
-- -----------------------------------------------------------------------------
create table public.ticket_attachments (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies (id),
  kind            text not null default 'scale_ticket_photo' check (kind = 'scale_ticket_photo'),
  status          text not null default 'pending' check (status in ('pending', 'uploaded', 'attached', 'discarded')),
  object_path     text not null unique check (object_path ~ '^[0-9a-f-]{36}/ticket-photos/[0-9a-f-]{36}\.(jpg|png|webp)$'),
  mime_type       text not null check (mime_type in ('image/jpeg', 'image/png', 'image/webp')),
  size_bytes      integer not null check (size_bytes between 1 and 5242880),
  sha256          text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  upload_key      uuid not null,
  assignment_id   uuid not null,
  load_id         uuid not null,
  order_id        uuid not null,
  ticket_id       uuid,
  ticket_number   text,
  created_by      uuid references auth.users (id) on delete set null,
  created_at      timestamptz not null default now(),
  uploaded_at     timestamptz,
  attached_at     timestamptz,
  discarded_at    timestamptz,
  discard_reason  text not null default '',
  unique (company_id, id),
  unique (company_id, upload_key),
  constraint ticket_attachments_path_company check (split_part(object_path, '/', 1) = company_id::text),
  constraint ticket_attachments_assignment_fk foreign key (company_id, assignment_id)
    references public.dispatch_assignments (company_id, id) on delete cascade,
  constraint ticket_attachments_load_fk foreign key (company_id, load_id) references public.order_loads (company_id, id) on delete cascade,
  constraint ticket_attachments_order_fk foreign key (company_id, order_id) references public.orders (company_id, id) on delete cascade,
  constraint ticket_attachments_ticket_fk foreign key (company_id, ticket_id) references public.delivery_tickets (company_id, id) on delete cascade,
  constraint ticket_attachments_state check (
    (status = 'pending' and uploaded_at is null and ticket_id is null)
    or (status = 'uploaded' and uploaded_at is not null and ticket_id is null)
    or (status = 'attached' and uploaded_at is not null and ticket_id is not null and ticket_number is not null and attached_at is not null)
    or (status = 'discarded' and discarded_at is not null and ticket_id is null and length(trim(discard_reason)) > 0))
);
create index ticket_attachments_ticket_idx on public.ticket_attachments (company_id, ticket_number) where status = 'attached';
create index ticket_attachments_open_idx on public.ticket_attachments (company_id, status, created_at) where status in ('pending', 'uploaded');

-- Records only move forward (pending → uploaded → attached, or → discarded
-- before attachment); identity fields never change; never deleted except with
-- their sample order.
create or replace function private.guard_ticket_attachment()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if current_setting('tlt.sample_purge', true) = 'on' then return old; end if;
    raise exception 'Ticket attachments cannot be deleted.' using errcode = '42501';
  end if;
  if (new.object_path, new.mime_type, new.size_bytes, new.sha256, new.upload_key, new.assignment_id, new.load_id,
      new.order_id, new.created_by, new.created_at, new.kind)
     is distinct from
     (old.object_path, old.mime_type, old.size_bytes, old.sha256, old.upload_key, old.assignment_id, old.load_id,
      old.order_id, old.created_by, old.created_at, old.kind)
     or not ((old.status = new.status and old is not distinct from new)
             or (old.status = 'pending' and new.status in ('uploaded', 'discarded'))
             or (old.status = 'uploaded' and new.status in ('attached', 'discarded'))) then
    raise exception 'A ticket attachment cannot be changed this way.' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger ticket_attachments_guard before update or delete on public.ticket_attachments
  for each row execute function private.guard_ticket_attachment();
create trigger a_company_guard before update of company_id on public.ticket_attachments
  for each row execute function private.forbid_company_change();

alter table public.ticket_attachments enable row level security;
-- Office review sees attached photos of its company (the file itself needs a signed URL).
create policy ticket_attachments_read on public.ticket_attachments for select to authenticated
  using (company_id = (select private.current_company_id())
         and status = 'attached'
         and (select private.has_permission('tickets.view')));
revoke all on public.ticket_attachments from anon, authenticated;
grant select on public.ticket_attachments to authenticated;
grant all on public.ticket_attachments to service_role;

-- -----------------------------------------------------------------------------
-- 2. Storage authorization helpers (used by the storage.objects policies)
-- -----------------------------------------------------------------------------
-- May the caller upload this object? Only to the exact path of their own
-- pending attachment, in their current company.
create or replace function private.can_upload_ticket_photo(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.ticket_attachments a
    where a.object_path = p_name
      and a.status = 'pending'
      and a.created_by = auth.uid()
      and a.company_id = private.current_company_id()
      and split_part(p_name, '/', 1) = a.company_id::text)
$$;

-- May the caller read (sign a URL for) this object? Attached photos of their
-- company, with tickets.view.
create or replace function private.can_read_ticket_photo(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.has_permission('tickets.view') and exists (
    select 1 from public.ticket_attachments a
    where a.object_path = p_name
      and a.status = 'attached'
      and a.company_id = private.current_company_id())
$$;

-- Bucket and policies. Idempotent; called below when storage is installed,
-- or by an operator after enabling storage.
create or replace function private.setup_ticket_photo_storage()
returns void
language plpgsql
set search_path = ''
as $$
begin
  if to_regclass('storage.objects') is null or to_regclass('storage.buckets') is null then
    raise exception 'Supabase Storage is not installed in this database.';
  end if;
  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('ticket-photos', 'ticket-photos', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
  on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
                                 allowed_mime_types = excluded.allowed_mime_types;

  drop policy if exists ticket_photos_insert on storage.objects;
  drop policy if exists ticket_photos_read on storage.objects;
  create policy ticket_photos_insert on storage.objects for insert to authenticated
    with check (bucket_id = 'ticket-photos' and private.can_upload_ticket_photo(name));
  create policy ticket_photos_read on storage.objects for select to authenticated
    using (bucket_id = 'ticket-photos' and private.can_read_ticket_photo(name));
  -- No update or delete policies: app users can never replace or remove a photo.
end;
$$;

grant usage on schema private to authenticated;
grant execute on function private.can_upload_ticket_photo(text), private.can_read_ticket_photo(text) to authenticated;

do $$
begin
  if to_regclass('storage.objects') is not null then
    perform private.setup_ticket_photo_storage();
  else
    raise notice 'Supabase Storage is not installed: run select private.setup_ticket_photo_storage(); after enabling it.';
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- 3. Driver upload steps
-- -----------------------------------------------------------------------------
-- Reserve a path for a photo of the paper ticket of the driver's own load.
-- Idempotent per upload key (a retry gets the same path). At most 3 photos
-- waiting per assignment.
create or replace function public.driver_begin_ticket_photo(p_assignment_id uuid, p_upload_key uuid, p_mime text, p_size integer, p_sha256 text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_d     public.drivers%rowtype := private.portal_driver();
  v_today date := private.business_today(v_d.company_id);
  v_a     public.dispatch_assignments%rowtype;
  v_l     public.order_loads%rowtype;
  v_r     public.ticket_attachments%rowtype;
  v_id    uuid := gen_random_uuid();
begin
  if p_upload_key is null then raise exception 'Missing upload key.'; end if;
  select * into v_r from public.ticket_attachments where company_id = v_d.company_id and upload_key = p_upload_key;
  if found then
    if v_r.created_by is distinct from auth.uid() then raise exception 'This upload was already used.' using errcode = '42501'; end if;
    return jsonb_build_object('attachment_id', v_r.id, 'object_path', v_r.object_path, 'status', v_r.status);
  end if;

  if p_mime is null or p_mime not in ('image/jpeg', 'image/png', 'image/webp') then
    raise exception 'Only JPEG, PNG or WebP photos can be attached.';
  end if;
  if p_size is null or p_size < 1 or p_size > 5242880 then raise exception 'The photo must be 5 MB or smaller.'; end if;
  if p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$' then raise exception 'Invalid file checksum.'; end if;

  select * into v_a from public.dispatch_assignments
  where id = p_assignment_id and company_id = v_d.company_id and driver_id = v_d.id and status = 'active';
  if not found then
    raise exception 'This load is not assigned to you (or the assignment changed). Refresh your list.' using errcode = '42501';
  end if;
  select * into v_l from public.order_loads where id = v_a.load_id;
  if v_l.load_date > v_today or v_l.load_date < v_today - 2 then
    raise exception 'Photos can be added for loads from two days ago to today.';
  end if;
  if (select count(*) from public.ticket_attachments
      where company_id = v_d.company_id and assignment_id = v_a.id and created_by = auth.uid()
        and status in ('pending', 'uploaded')) >= 3 then
    raise exception 'At most 3 photos can wait for a ticket. Send the ticket first.';
  end if;

  insert into public.ticket_attachments (id, company_id, object_path, mime_type, size_bytes, sha256, upload_key,
                                         assignment_id, load_id, order_id, created_by)
  values (v_id, v_d.company_id,
          v_d.company_id || '/ticket-photos/' || v_id || case p_mime when 'image/jpeg' then '.jpg' when 'image/png' then '.png' else '.webp' end,
          p_mime, p_size, p_sha256, p_upload_key, v_a.id, v_l.id, v_l.order_id, auth.uid())
  returning * into v_r;
  return jsonb_build_object('attachment_id', v_r.id, 'object_path', v_r.object_path, 'status', v_r.status);
end;
$$;

-- After the upload: confirm the stored object matches what was declared.
create or replace function public.driver_confirm_ticket_photo(p_attachment_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_d    public.drivers%rowtype := private.portal_driver();
  v_r    public.ticket_attachments%rowtype;
  v_size bigint;
  v_mime text;
  v_n    integer;
begin
  select * into v_r from public.ticket_attachments
  where id = p_attachment_id and company_id = v_d.company_id and created_by = auth.uid() for update;
  if not found then raise exception 'Photo not found.' using errcode = '42501'; end if;
  if v_r.status in ('uploaded', 'attached') then
    return jsonb_build_object('attachment_id', v_r.id, 'status', v_r.status);
  end if;
  if v_r.status <> 'pending' then raise exception 'This photo was discarded. Take it again.'; end if;

  select (o.metadata ->> 'size')::bigint, o.metadata ->> 'mimetype' into v_size, v_mime
  from storage.objects o where o.bucket_id = 'ticket-photos' and o.name = v_r.object_path;
  if not found then raise exception 'The photo did not arrive. Try again.'; end if;
  if v_size is distinct from v_r.size_bytes or v_mime is distinct from v_r.mime_type then
    raise exception 'The stored photo does not match what was sent. Try again.';
  end if;

  update public.ticket_attachments set status = 'uploaded', uploaded_at = now() where id = v_r.id;
  select l.load_number into v_n from public.order_loads l where l.id = v_r.load_id;
  perform private.log_event('ticket_photo.uploaded', 'order', v_r.order_id,
    format('Paper ticket photo uploaded by %s for load %s (%s KB)',
           coalesce((select nullif(trim(full_name), '') from public.profiles where id = auth.uid()), 'the driver'), v_n,
           ceil(v_r.size_bytes / 1024.0)),
    jsonb_build_object('attachment_id', v_r.id));
  return jsonb_build_object('attachment_id', v_r.id, 'status', 'uploaded');
end;
$$;

-- -----------------------------------------------------------------------------
-- 4. Driver ticket submission with photos
-- -----------------------------------------------------------------------------
create or replace function public.driver_submit_ticket(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_d        public.drivers%rowtype := private.portal_driver();
  v_key      uuid := nullif(p_payload ->> 'submission_key', '')::uuid;
  v_existing public.delivery_tickets%rowtype;
  v_a        public.dispatch_assignments%rowtype;
  v_date     date;
  v_photos   uuid[];
  v_result   jsonb;
  v_count    integer;
begin
  if v_key is null then raise exception 'Missing submission key. Reload the page.'; end if;
  select * into v_existing from public.delivery_tickets where company_id = v_d.company_id and submission_key = v_key;
  if found then
    if v_existing.created_by is distinct from auth.uid() then
      raise exception 'This submission was already used.' using errcode = '42501';
    end if;
    -- A retry: the first request already attached its photos.
    return jsonb_build_object('ticket_id', v_existing.id, 'ticket_number', v_existing.ticket_number, 'status', v_existing.status, 'created', false,
      'photos', (select count(*) from public.ticket_attachments a where a.company_id = v_d.company_id and a.ticket_number = v_existing.ticket_number));
  end if;

  select * into v_a from public.dispatch_assignments
  where id = nullif(p_payload ->> 'assignment_id', '')::uuid and company_id = v_d.company_id
    and driver_id = v_d.id and status = 'active';
  if not found then
    raise exception 'This load is not assigned to you (or the assignment changed). Refresh your list.' using errcode = '42501';
  end if;
  select load_date into v_date from public.order_loads where id = v_a.load_id;
  if v_date > private.business_today(v_d.company_id) then
    raise exception 'You can enter the ticket from the day of the load.';
  end if;

  -- Photos: own uploads for this assignment, confirmed (status uploaded), at most 3.
  select coalesce(array_agg(distinct x::uuid), '{}') into v_photos
  from jsonb_array_elements_text(coalesce(p_payload -> 'photo_ids', '[]'::jsonb)) x;
  if cardinality(v_photos) > 3 then raise exception 'At most 3 photos per ticket.'; end if;
  if cardinality(v_photos) > 0 then
    perform 1 from public.ticket_attachments
    where id = any(v_photos) and company_id = v_d.company_id and created_by = auth.uid()
      and assignment_id = v_a.id and status = 'uploaded'
    for update;
    get diagnostics v_count = row_count;
    if v_count <> cardinality(v_photos) then
      raise exception 'A photo is not ready (still uploading, or not yours). Wait for the upload or remove the photo.';
    end if;
  end if;

  v_result := private.create_ticket(v_d.company_id, jsonb_build_object(
    'load_id', v_a.load_id,
    'order_line_id', p_payload -> 'order_line_id',
    'delivered_date', p_payload -> 'delivered_date',
    'delivered_time', p_payload -> 'delivered_time',
    'quantity', p_payload -> 'quantity',
    'unit_code', p_payload -> 'unit_code',
    'external_reference', p_payload -> 'external_reference',
    'notes', p_payload -> 'notes',
    'submission_key', v_key,
    'confirm_duplicate', coalesce(p_payload -> 'confirm_duplicate', 'false'::jsonb)), 'driver_portal');

  if cardinality(v_photos) > 0 and (v_result ->> 'created')::boolean then
    update public.ticket_attachments
       set status = 'attached', ticket_id = (v_result ->> 'ticket_id')::uuid,
           ticket_number = v_result ->> 'ticket_number', attached_at = now()
     where id = any(v_photos);
    perform private.log_event('ticket_photo.attached', 'order',
      (select order_id from public.delivery_tickets where id = (v_result ->> 'ticket_id')::uuid),
      format('%s paper ticket photo%s attached to ticket %s', cardinality(v_photos),
             case when cardinality(v_photos) = 1 then '' else 's' end, v_result ->> 'ticket_number'),
      jsonb_build_object('ticket_id', v_result ->> 'ticket_id', 'attachment_ids', to_jsonb(v_photos)));
  end if;
  return v_result || jsonb_build_object('photos', case when (v_result ->> 'created')::boolean then cardinality(v_photos) else
    (select count(*) from public.ticket_attachments a where a.ticket_id = (v_result ->> 'ticket_id')::uuid) end);
end;
$$;

-- -----------------------------------------------------------------------------
-- 5. Abandoned uploads (service role; scripts/cleanup-ticket-photos.mjs)
-- -----------------------------------------------------------------------------
-- Unattached photos older than p_hours, and objects in the bucket with no
-- live attachment row (e.g. left behind by the sample purge).
create or replace function public.abandoned_ticket_photos(p_hours integer default 24)
returns table (attachment_id uuid, object_path text, reason text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  return query
  select a.id, a.object_path, 'not attached within ' || greatest(p_hours, 1) || ' hours'
  from public.ticket_attachments a
  where a.status in ('pending', 'uploaded') and a.created_at < now() - make_interval(hours => greatest(p_hours, 1))
  union all
  select null::uuid, o.name, 'no attachment record'
  from storage.objects o
  where o.bucket_id = 'ticket-photos'
    and not exists (select 1 from public.ticket_attachments a where a.object_path = o.name and a.status <> 'discarded');
end;
$$;

-- Mark abandoned rows discarded once their objects are gone from storage.
create or replace function public.mark_ticket_photos_discarded(p_attachment_ids uuid[])
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n integer;
begin
  update public.ticket_attachments a
     set status = 'discarded', discarded_at = now(), discard_reason = 'Abandoned upload removed'
   where a.id = any(p_attachment_ids) and a.status in ('pending', 'uploaded')
     and not exists (select 1 from storage.objects o where o.bucket_id = 'ticket-photos' and o.name = a.object_path);
  get diagnostics v_n = row_count;
  insert into public.audit_events (company_id, actor_id, action, entity_type, entity_id, summary, details)
  select a.company_id, null, 'ticket_photo.discarded', 'order', a.order_id, 'Abandoned ticket photo upload removed',
         jsonb_build_object('attachment_id', a.id)
  from public.ticket_attachments a
  where a.id = any(p_attachment_ids) and a.status = 'discarded' and a.discarded_at >= now() - interval '1 second';
  return v_n;
end;
$$;

-- -----------------------------------------------------------------------------
-- 6. Grants
-- -----------------------------------------------------------------------------
revoke execute on function
  public.driver_begin_ticket_photo(uuid, uuid, text, integer, text),
  public.driver_confirm_ticket_photo(uuid)
from public, anon;
grant execute on function
  public.driver_begin_ticket_photo(uuid, uuid, text, integer, text),
  public.driver_confirm_ticket_photo(uuid)
to authenticated;

revoke execute on function
  public.abandoned_ticket_photos(integer),
  public.mark_ticket_photos_discarded(uuid[])
from public, anon, authenticated;
grant execute on function
  public.abandoned_ticket_photos(integer),
  public.mark_ticket_photos_discarded(uuid[])
to service_role;

revoke execute on function
  private.guard_ticket_attachment(),
  private.setup_ticket_photo_storage()
from public, anon, authenticated;
