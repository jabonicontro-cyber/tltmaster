-- Sample ticket photos for demo customers (UX13, owner 2026-11-04: "portal ticket photos" in the demo data). A demo
-- customer's portal shows the photos of their confirmed tickets (B98, public.portal_ticket_proof); demo tickets had
-- none, because only a driver's phone adds them. The shared samples (src/server/demo/samples.ts) now add one fictional
-- photo, an image clearly marked SAMPLE, to the latest confirmed ticket of each demo customer, at most 8 per demo.
--
-- Stored exactly as a driver's photo is: a pending attachment reserves the path, the demo owner's own session uploads
-- the file to the private ticket-photos bucket (the existing storage policy allows only that reserved path), and the
-- database then checks the stored object's size and type and attaches it to the ticket. Three functions, each for the
-- OWNER of a DEMO company only (private.demo_owner_company(): the active company, is_demo, an active owner membership);
-- a real company is refused:
--   * public.demo_ticket_photo_targets(): the tickets that still need a sample photo, with what the image shows.
--   * public.demo_ticket_photo_begin(ticket, mime, size, sha256): reserves the path (idempotent per ticket).
--   * public.demo_ticket_photo_attach(attachment): attaches it once the file is stored.
-- A sample photo is recognised by its upload key, derived from the ticket (md5 of 'demo-ticket-photo:' and the ticket
-- id), so a repeat never adds a second one and a person's own photos are never touched. Nothing is sent anywhere.
--
-- Additive: three functions. Reversible: supabase/rollbacks/20261120020900_demo_ticket_photo_samples.down.sql

create or replace function private.demo_ticket_photo_key(p_ticket uuid)
returns uuid
language sql
immutable
set search_path = ''
as $$
  select md5('demo-ticket-photo:' || p_ticket::text)::uuid;
$$;
revoke all on function private.demo_ticket_photo_key(uuid) from public, anon, authenticated;

-- Tickets that still need a sample photo: per demo customer without one, their latest confirmed ticket that has no
-- photo, until the demo has 8 sample photos.
create or replace function public.demo_ticket_photo_targets()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_demo uuid := private.demo_owner_company();
  v_have integer;
begin
  if v_demo is null then
    raise exception 'Demo samples are only added to a demo company, by its owner.' using errcode = '42501';
  end if;
  select count(*) into v_have from public.ticket_attachments a
   where a.company_id = v_demo and a.status = 'attached' and a.upload_key = private.demo_ticket_photo_key(a.ticket_id);
  if v_have >= 8 then
    return '[]'::jsonb;
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('ticket_id', x.id, 'ticket_number', x.ticket_number) order by x.delivered_at desc)
      from (
        select distinct on (o.customer_id) t.id, t.ticket_number, t.delivered_at
          from public.delivery_tickets t
          join public.orders o on o.id = t.order_id and o.company_id = t.company_id
         where t.company_id = v_demo and t.status = 'accepted'
           and not exists (select 1 from public.ticket_attachments a where a.ticket_id = t.id and a.status = 'attached')
           -- A sample whose upload was abandoned (and cleaned up) is not tried again.
           and not exists (select 1 from public.ticket_attachments a
                            where a.company_id = v_demo and a.upload_key = private.demo_ticket_photo_key(t.id) and a.status = 'discarded')
           and not exists (
             select 1 from public.ticket_attachments a
               join public.delivery_tickets t2 on t2.id = a.ticket_id
               join public.orders o2 on o2.id = t2.order_id
              where a.company_id = v_demo and a.status = 'attached' and o2.customer_id = o.customer_id
                and a.upload_key = private.demo_ticket_photo_key(a.ticket_id))
         order by o.customer_id, t.delivered_at desc
      ) x
     limit greatest(8 - v_have, 0)), '[]'::jsonb);
end;
$$;

-- Reserve the path of one sample photo for a confirmed demo ticket (a repeat returns the same reservation).
create or replace function public.demo_ticket_photo_begin(p_ticket uuid, p_mime text, p_size integer, p_sha256 text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_demo uuid := private.demo_owner_company();
  v_t    public.delivery_tickets%rowtype;
  v_r    public.ticket_attachments%rowtype;
  v_key  uuid;
  v_id   uuid := gen_random_uuid();
begin
  if v_demo is null then
    raise exception 'Demo samples are only added to a demo company, by its owner.' using errcode = '42501';
  end if;
  select * into v_t from public.delivery_tickets where id = p_ticket and company_id = v_demo and status = 'accepted';
  if not found then
    raise exception 'Ticket not found.' using errcode = 'P0002';
  end if;
  if p_mime is null or p_mime not in ('image/jpeg', 'image/png', 'image/webp') or p_size is null or p_size < 1 or p_size > 5242880 then
    raise exception 'Sample photos are JPEG, PNG or WebP images of at most 5 MB.' using errcode = '22023';
  end if;
  if p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid file checksum.' using errcode = '22023';
  end if;
  v_key := private.demo_ticket_photo_key(v_t.id);
  select * into v_r from public.ticket_attachments where company_id = v_demo and upload_key = v_key;
  if found then
    if v_r.status = 'pending' and v_r.created_by is distinct from auth.uid() then
      raise exception 'Another owner of this demo is adding this sample photo.' using errcode = '42501';
    end if;
    return jsonb_build_object('attachment_id', v_r.id, 'object_path', v_r.object_path, 'status', v_r.status);
  end if;
  if exists (select 1 from public.ticket_attachments a where a.ticket_id = v_t.id and a.status = 'attached') then
    return jsonb_build_object('attachment_id', null, 'object_path', null, 'status', 'has_photos');
  end if;
  insert into public.ticket_attachments (id, company_id, object_path, mime_type, size_bytes, sha256, upload_key,
                                         assignment_id, load_id, order_id, created_by)
  values (v_id, v_demo,
          v_demo || '/ticket-photos/' || v_id || case p_mime when 'image/png' then '.png' when 'image/webp' then '.webp' else '.jpg' end,
          p_mime, p_size, p_sha256, v_key, v_t.assignment_id, v_t.load_id, v_t.order_id, auth.uid())
  returning * into v_r;
  return jsonb_build_object('attachment_id', v_r.id, 'object_path', v_r.object_path, 'status', v_r.status);
end;
$$;

-- Attach a stored sample photo to its ticket, after checking the stored object matches what was reserved.
create or replace function public.demo_ticket_photo_attach(p_attachment uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_demo uuid := private.demo_owner_company();
  v_r    public.ticket_attachments%rowtype;
  v_t    public.delivery_tickets%rowtype;
  v_size bigint;
  v_mime text;
begin
  if v_demo is null then
    raise exception 'Demo samples are only added to a demo company, by its owner.' using errcode = '42501';
  end if;
  select * into v_r from public.ticket_attachments where id = p_attachment and company_id = v_demo for update;
  if not found then
    raise exception 'Photo not found.' using errcode = 'P0002';
  end if;
  if v_r.status = 'attached' then
    return false;
  end if;
  select * into v_t from public.delivery_tickets t
   where t.company_id = v_demo and t.load_id = v_r.load_id and t.status = 'accepted' and private.demo_ticket_photo_key(t.id) = v_r.upload_key;
  if not found or v_r.status not in ('pending', 'uploaded') or v_r.created_by is distinct from auth.uid() then
    raise exception 'This is not a sample photo waiting to be attached.' using errcode = '42501';
  end if;
  select (o.metadata ->> 'size')::bigint, o.metadata ->> 'mimetype' into v_size, v_mime
    from storage.objects o where o.bucket_id = 'ticket-photos' and o.name = v_r.object_path;
  if not found then
    raise exception 'The sample photo did not arrive. Try again.' using errcode = '22023';
  end if;
  if v_size is distinct from v_r.size_bytes::bigint or v_mime is distinct from v_r.mime_type then
    raise exception 'The stored sample photo does not match what was reserved.' using errcode = '22023';
  end if;
  if v_r.status = 'pending' then
    update public.ticket_attachments set status = 'uploaded', uploaded_at = now() where id = v_r.id;
  end if;
  update public.ticket_attachments
     set status = 'attached', ticket_id = v_t.id, ticket_number = v_t.ticket_number, attached_at = now()
   where id = v_r.id;
  perform private.log_event('ticket_photo.attached', 'order', v_t.order_id,
    format('Sample ticket photo (demo, fictional) attached to ticket %s', v_t.ticket_number),
    jsonb_build_object('ticket_id', v_t.id, 'attachment_ids', jsonb_build_array(v_r.id), 'sample', true));
  return true;
end;
$$;

revoke all on function public.demo_ticket_photo_targets(), public.demo_ticket_photo_begin(uuid, text, integer, text),
  public.demo_ticket_photo_attach(uuid) from public, anon;
grant execute on function public.demo_ticket_photo_targets(), public.demo_ticket_photo_begin(uuid, text, integer, text),
  public.demo_ticket_photo_attach(uuid) to authenticated;
