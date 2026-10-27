-- Job-site notes and photos from customers (master plan B94, owner 2026-10-27).
--
-- A customer tells the hauler about their job site once, on the portal: gate code, where to drop, who is on site,
-- notes and up to three photos. Nothing reaches drivers until the office reviews it:
--   * public.portal_sites(slug)                 the customer's own active sites
--   * public.portal_site_info_submit(slug, ...)  a pending submission for one of their sites (at most 5 pending per site)
--   * public.portal_site_photo_begin(slug, ...)  reserves a photo path on a pending submission (app uploads the file)
--   * public.site_info_review(id, apply, text)   customers.edit: apply writes the reviewed text into the site's
--                                                directions (which makes them unverified until someone verifies them,
--                                                20261115000200) and turns the photos into site photos; decline keeps
--                                                nothing for drivers
--   * public.site_photo_path(id)                 the file path for staff of the company (customers, dispatch or a
--                                                driver); the app signs a one-minute link
-- Files live in the private 'site-photos' bucket, written and read only by the server (service role) after these
-- functions allow it.
--
-- Reversible: supabase/rollbacks/20261120004100_site_info_from_customers.down.sql

create table public.site_info_submissions (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies (id),
  customer_id     uuid not null,
  site_id         uuid not null,
  gate_code       text not null default '' check (length(gate_code) <= 60),
  drop_spot       text not null default '' check (length(drop_spot) <= 500),
  contact_name    text not null default '' check (length(contact_name) <= 120),
  contact_phone   text not null default '' check (length(contact_phone) <= 40),
  notes           text not null default '' check (length(notes) <= 2000),
  status          text not null default 'pending' check (status in ('pending', 'applied', 'declined')),
  submitted_by    uuid references auth.users (id) on delete set null,
  submitted_at    timestamptz not null default now(),
  reviewed_by     uuid references auth.users (id) on delete set null,
  reviewed_at     timestamptz,
  review_note     text not null default '' check (length(review_note) <= 500),
  unique (company_id, id),
  foreign key (company_id, site_id) references public.customer_sites (company_id, id) on delete cascade,
  constraint site_info_has_content check (length(trim(gate_code || drop_spot || contact_name || contact_phone || notes)) > 0)
);
create index site_info_submissions_pending on public.site_info_submissions (company_id, status, submitted_at);

create table public.site_photos (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies (id),
  site_id         uuid not null,
  submission_id   uuid not null,
  object_path     text not null unique check (object_path ~ '^[0-9a-f-]{36}/site-photos/[0-9a-f-]{36}\.(jpg|png|webp)$'),
  mime_type       text not null check (mime_type in ('image/jpeg', 'image/png', 'image/webp')),
  size_bytes      integer not null check (size_bytes between 1 and 5242880),
  status          text not null default 'pending' check (status in ('pending', 'site', 'declined')),
  created_at      timestamptz not null default now(),
  foreign key (company_id, site_id) references public.customer_sites (company_id, id) on delete cascade,
  foreign key (company_id, submission_id) references public.site_info_submissions (company_id, id) on delete cascade
);
create index site_photos_site on public.site_photos (company_id, site_id) where status = 'site';

alter table public.site_info_submissions enable row level security;
alter table public.site_photos enable row level security;

-- The office reads submissions with customer access; drivers and dispatch read only applied site photos.
create policy site_info_submissions_read on public.site_info_submissions for select to authenticated
  using (company_id = (select private.current_company_id()) and (select private.has_permission('customers.view')));
create policy site_photos_read on public.site_photos for select to authenticated
  using (company_id = (select private.current_company_id())
         and ((select private.has_permission('customers.view'))
              or (status = 'site' and ((select private.has_permission('dispatch.view')) or (select private.has_permission('driver.portal'))))));
revoke all on public.site_info_submissions, public.site_photos from anon;
grant select on public.site_info_submissions, public.site_photos to authenticated;

-- Customer: their own active sites.
create or replace function public.portal_sites(p_slug text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v public.portal_accounts%rowtype := private.portal_me(p_slug);
begin
  return (select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'label', s.label, 'address', concat_ws(', ', nullif(s.line1, ''), nullif(s.city, '')),
                                                        'pending', (select count(*) from public.site_info_submissions x where x.site_id = s.id and x.status = 'pending'))
                                    order by s.label), '[]'::jsonb)
            from public.customer_sites s
           where s.company_id = v.company_id and s.customer_id = v.customer_id and s.active);
end;
$$;

create or replace function public.portal_site_info_submit(p_slug text, p_site uuid, p_gate text, p_drop text, p_contact text, p_phone text, p_notes text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.portal_accounts%rowtype := private.portal_me(p_slug);
  v_id uuid;
begin
  if not exists (select 1 from public.customer_sites s where s.id = p_site and s.company_id = v.company_id and s.customer_id = v.customer_id and s.active) then
    raise exception 'Site not found.' using errcode = 'P0002';
  end if;
  if (select count(*) from public.site_info_submissions x where x.site_id = p_site and x.status = 'pending') >= 5 then
    raise exception 'This site already has five notes waiting for the office.' using errcode = '22023';
  end if;
  insert into public.site_info_submissions (company_id, customer_id, site_id, gate_code, drop_spot, contact_name, contact_phone, notes, submitted_by)
  values (v.company_id, v.customer_id, p_site, left(trim(coalesce(p_gate, '')), 60), left(trim(coalesce(p_drop, '')), 500),
          left(trim(coalesce(p_contact, '')), 120), left(trim(coalesce(p_phone, '')), 40), left(trim(coalesce(p_notes, '')), 2000), auth.uid())
  returning id into v_id;
  return v_id;
exception when check_violation then
  raise exception 'Add at least one detail about the site.' using errcode = '22023';
end;
$$;

-- Reserves a path for one photo (at most 3) on the customer's own pending submission; the app uploads the file there.
create or replace function public.portal_site_photo_begin(p_slug text, p_submission uuid, p_mime text, p_size integer)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.portal_accounts%rowtype := private.portal_me(p_slug);
  x public.site_info_submissions%rowtype;
  v_path text;
begin
  select * into x from public.site_info_submissions
   where id = p_submission and company_id = v.company_id and customer_id = v.customer_id and status = 'pending' and submitted_by = auth.uid();
  if not found then
    raise exception 'Submission not found.' using errcode = 'P0002';
  end if;
  if p_mime not in ('image/jpeg', 'image/png', 'image/webp') or p_size is null or p_size < 1 or p_size > 5242880 then
    raise exception 'Photos must be JPEG, PNG or WebP and at most 5 MB.' using errcode = '22023';
  end if;
  if (select count(*) from public.site_photos p where p.submission_id = x.id) >= 3 then
    raise exception 'At most 3 photos.' using errcode = '22023';
  end if;
  v_path := format('%s/site-photos/%s.%s', x.company_id, gen_random_uuid(), case p_mime when 'image/png' then 'png' when 'image/webp' then 'webp' else 'jpg' end);
  insert into public.site_photos (company_id, site_id, submission_id, object_path, mime_type, size_bytes)
  values (x.company_id, x.site_id, x.id, v_path, p_mime, p_size);
  return v_path;
end;
$$;

-- Office review (customers.edit): apply the reviewed text to the site's directions and keep the photos, or decline.
create or replace function public.site_info_review(p_id uuid, p_apply boolean, p_directions text, p_note text default '')
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.current_company_id();
  x public.site_info_submissions%rowtype;
begin
  if not private.has_permission('customers.edit') then
    raise exception 'You do not have permission to change customer sites.' using errcode = '42501';
  end if;
  select * into x from public.site_info_submissions where id = p_id and company_id = v_company for update;
  if not found then
    raise exception 'Submission not found.' using errcode = 'P0002';
  end if;
  if x.status <> 'pending' then
    raise exception 'This submission was already reviewed.' using errcode = '22023';
  end if;
  if p_apply then
    if p_directions is null or length(trim(p_directions)) = 0 or length(p_directions) > 4000 then
      raise exception 'Enter the directions drivers should see (up to 4000 characters).' using errcode = '22023';
    end if;
    -- The normal site update: changed directions become unverified until someone verifies them (20261115000200).
    update public.customer_sites set directions = p_directions where id = x.site_id and company_id = v_company;
    update public.site_photos set status = 'site' where submission_id = x.id;
  else
    update public.site_photos set status = 'declined' where submission_id = x.id;
  end if;
  update public.site_info_submissions
     set status = case when p_apply then 'applied' else 'declined' end, reviewed_by = auth.uid(), reviewed_at = now(),
         review_note = left(coalesce(p_note, ''), 500)
   where id = x.id;
  return case when p_apply then 'applied' else 'declined' end;
end;
$$;

-- The file path of a site photo for staff who may see it (the app signs a short link with the service role).
create or replace function public.site_photo_path(p_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select p.object_path from public.site_photos p
   where p.id = p_id and p.company_id = private.current_company_id()
     and (private.has_permission('customers.view')
          or (p.status = 'site' and (private.has_permission('dispatch.view') or private.has_permission('driver.portal'))));
$$;

-- The driver's own loads (from yesterday on) with the applied photos of their job site, for My Day.
create or replace function public.driver_site_photos()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_d public.drivers%rowtype := private.portal_driver();
begin
  return (select coalesce(jsonb_object_agg(x.load_id, x.photos), '{}'::jsonb)
            from (select l.id as load_id, jsonb_agg(p.id order by p.created_at) as photos
                    from public.dispatch_assignments a
                    join public.order_loads l on l.id = a.load_id
                    join public.orders o on o.id = l.order_id
                    join public.site_photos p on p.company_id = a.company_id and p.site_id = o.site_id and p.status = 'site'
                   where a.company_id = v_d.company_id and a.driver_id = v_d.id and a.status = 'active'
                     and l.load_date >= private.business_today(v_d.company_id) - 1
                   group by l.id) x);
end;
$$;
revoke all on function public.driver_site_photos() from public, anon;
grant execute on function public.driver_site_photos() to authenticated;

-- Demo samples: one pending note from a demo customer, so the office review has something to show (demo owner only).
create or replace function public.demo_site_note()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_demo uuid := private.demo_owner_company();
  v_site record;
begin
  if v_demo is null then
    raise exception 'Demo samples are only added to a demo company, by its owner.' using errcode = '42501';
  end if;
  if exists (select 1 from public.site_info_submissions where company_id = v_demo) then
    return 0;
  end if;
  select s.id, s.customer_id into v_site from public.customer_sites s
   where s.company_id = v_demo and s.active order by s.label limit 1;
  if not found then
    return 0;
  end if;
  insert into public.site_info_submissions (company_id, customer_id, site_id, gate_code, drop_spot, contact_name, contact_phone, notes)
  values (v_demo, v_site.customer_id, v_site.id, '4521#', 'North stockpile, left of the trailer (demo)', 'Sam (site lead, demo)', '555-0142',
          'Gate closes at 4:30 PM. Call Sam if it is locked. (Sample note in a demo company.)');
  return 1;
end;
$$;
revoke all on function public.demo_site_note() from public, anon;
grant execute on function public.demo_site_note() to authenticated;

revoke all on function public.portal_sites(text), public.portal_site_info_submit(text, uuid, text, text, text, text, text),
  public.portal_site_photo_begin(text, uuid, text, integer), public.site_info_review(uuid, boolean, text, text), public.site_photo_path(uuid) from public, anon;
grant execute on function public.portal_sites(text), public.portal_site_info_submit(text, uuid, text, text, text, text, text),
  public.portal_site_photo_begin(text, uuid, text, integer), public.site_info_review(uuid, boolean, text, text), public.site_photo_path(uuid) to authenticated;

-- The private bucket (no policies: only the server's service role reads and writes it).
do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('site-photos', 'site-photos', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
    on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
  end if;
end;
$$;
