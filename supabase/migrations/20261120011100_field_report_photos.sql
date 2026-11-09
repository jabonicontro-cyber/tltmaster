-- Photos on driver problem reports (owner 2026-11-09: "let the driver show the office what is wrong").
--
-- A driver adds up to 4 photos (JPEG, PNG, WebP, at most 5 MB each) to a report they sent, within an hour of sending
-- it, in the private field-report-photos bucket that only the server's service role reads and writes. Same pattern as
-- safety and order documents: the database checks who may add and reserves the exact storage path; the server checks
-- the bytes and stores the file at that path; people who may see the report open a photo through a one-minute signed
-- link (public.field_report_photo_path answers with the viewer's own session, so the report's own row-level security,
-- base scope included, decides). Nothing is sent anywhere.
-- Reversible: supabase/rollbacks/20261120011100_field_report_photos.down.sql

create table public.field_report_photos (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies (id),
  report_id    uuid not null,
  object_path  text not null unique check (object_path ~ '^[0-9a-f-]{36}/field-reports/[0-9a-f-]{36}\.(jpg|png|webp)$'),
  mime_type    text not null check (mime_type in ('image/jpeg', 'image/png', 'image/webp')),
  size_bytes   integer not null check (size_bytes between 1 and 5242880),
  uploaded_by  uuid references auth.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  -- An upload the storage refused: the reservation is kept on record but never shown.
  failed_at    timestamptz,
  unique (company_id, id),
  foreign key (company_id, report_id) references public.field_reports (company_id, id) on delete cascade
);
create index field_report_photos_report_idx on public.field_report_photos (report_id, created_at) where failed_at is null;

alter table public.field_report_photos enable row level security;
-- Visible exactly when the report is (field_reports' own policies, including base scope, apply inside the subquery).
create policy field_report_photos_read on public.field_report_photos for select to authenticated
  using (company_id = (select private.current_company_id())
         and exists (select 1 from public.field_reports r where r.id = field_report_photos.report_id));
revoke all on public.field_report_photos from anon, authenticated;
grant select on public.field_report_photos to authenticated;

-- Reserve one photo on a report: the driver who sent it, within an hour, at most 4. Returns the storage path.
create or replace function public.field_report_photo_begin(p_report uuid, p_mime text, p_size integer)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_d    public.drivers%rowtype := private.portal_driver();
  v_r    public.field_reports%rowtype;
  v_path text;
begin
  select * into v_r from public.field_reports
   where id = p_report and company_id = v_d.company_id and driver_id = v_d.id and reported_by = auth.uid()
   for update;
  if not found then
    raise exception 'Report not found.' using errcode = 'P0002';
  end if;
  if v_r.created_at < now() - interval '1 hour' then
    raise exception 'Photos can be added for an hour after the report is sent. Send a new report, or call the office.' using errcode = '22023';
  end if;
  if p_mime is null or p_mime not in ('image/jpeg', 'image/png', 'image/webp') or p_size is null or p_size < 1 or p_size > 5242880 then
    raise exception 'Photos must be JPEG, PNG or WebP and at most 5 MB.' using errcode = '22023';
  end if;
  if (select count(*) from public.field_report_photos p where p.report_id = v_r.id and p.failed_at is null) >= 4 then
    raise exception 'At most 4 photos per report.' using errcode = '22023';
  end if;
  v_path := format('%s/field-reports/%s.%s', v_r.company_id, gen_random_uuid(),
                   case p_mime when 'image/png' then 'png' when 'image/webp' then 'webp' else 'jpg' end);
  insert into public.field_report_photos (company_id, report_id, object_path, mime_type, size_bytes, uploaded_by)
  values (v_r.company_id, v_r.id, v_path, p_mime, p_size, auth.uid());
  perform private.log_event('field_report.photo_added', 'order', v_r.order_id,
    format('Photo added to a driver report (%s load %s)', v_r.snapshot ->> 'order_number', v_r.snapshot ->> 'load_number'),
    jsonb_build_object('report_id', v_r.id));
  return v_path;
end;
$$;

-- Where a photo is stored, for a person who may see its report (read with their own session and its row-level
-- security, so it is not elevated). The server signs a one-minute link.
create or replace function public.field_report_photo_path(p_photo uuid)
returns text
language sql
stable
security invoker
set search_path = ''
as $$
  select p.object_path from public.field_report_photos p
   where p.id = p_photo and p.failed_at is null;
$$;

revoke all on function public.field_report_photo_begin(uuid, text, integer), public.field_report_photo_path(uuid) from public, anon;
grant execute on function public.field_report_photo_begin(uuid, text, integer), public.field_report_photo_path(uuid) to authenticated;

-- The private bucket (no policies: only the server's service role reads and writes it).
do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('field-report-photos', 'field-report-photos', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
    on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
  end if;
end;
$$;
