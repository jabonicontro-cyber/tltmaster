-- Proof of delivery for customers (master plan B98, owner 2026-10-27).
--
-- 1. Where a ticket was submitted: the driver's phone records its position once, right after the driver submits the
--    ticket (owner decision: at submission only, never tracked; the permission is asked and the ticket works without
--    it). Stored per ticket, separate from the ticket itself; only the driver who entered the ticket can record it,
--    within 15 minutes, once.
-- 2. The customer's proof: on their portal, a confirmed ticket shows its photos and where it was submitted, beside the
--    quantity and time they already see. Photos are read through public.portal_ticket_photo (path only for that
--    customer's own confirmed tickets); the app signs a short link to the file.
-- 3. Demo companies: public.demo_ticket_locations() places some confirmed tickets at their job site (demo owner only).
--
-- Reversible: supabase/rollbacks/20261120004000_proof_of_delivery.down.sql

create table public.ticket_locations (
  ticket_id    uuid primary key,
  company_id   uuid not null references public.companies (id),
  latitude     numeric(9, 6) not null check (latitude between -90 and 90),
  longitude    numeric(9, 6) not null check (longitude between -180 and 180),
  accuracy_m   numeric(8, 1) check (accuracy_m >= 0 and accuracy_m <= 100000),
  recorded_at  timestamptz not null default now(),
  recorded_by  uuid references auth.users (id) on delete set null,
  foreign key (company_id, ticket_id) references public.delivery_tickets (company_id, id) on delete cascade
);

alter table public.ticket_locations enable row level security;

-- Visible with the tickets (tickets.view or orders.view); written only through the functions below.
create policy ticket_locations_read on public.ticket_locations for select to authenticated
  using (company_id = (select private.current_company_id())
         and ((select private.has_permission('tickets.view')) or (select private.has_permission('orders.view'))));

revoke all on public.ticket_locations from anon;
grant select on public.ticket_locations to authenticated;

create or replace function public.driver_record_ticket_location(p_ticket uuid, p_lat numeric, p_lng numeric, p_accuracy numeric)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_t public.delivery_tickets%rowtype;
begin
  if p_lat is null or p_lng is null or p_lat not between -90 and 90 or p_lng not between -180 and 180 or (p_accuracy is not null and (p_accuracy < 0 or p_accuracy > 100000)) then
    raise exception 'That position is not valid.' using errcode = '22023';
  end if;
  select * into v_t from public.delivery_tickets
   where id = p_ticket and company_id = private.current_company_id() and created_by = auth.uid();
  if not found then
    raise exception 'Ticket not found.' using errcode = 'P0002';
  end if;
  if now() - v_t.created_at > interval '15 minutes' then
    raise exception 'The position can only be recorded when the ticket is submitted.' using errcode = '42501';
  end if;
  insert into public.ticket_locations (ticket_id, company_id, latitude, longitude, accuracy_m, recorded_by)
  values (v_t.id, v_t.company_id, round(p_lat, 6), round(p_lng, 6), round(p_accuracy, 1), auth.uid())
  on conflict (ticket_id) do nothing;
  return found;
end;
$$;
revoke all on function public.driver_record_ticket_location(uuid, numeric, numeric, numeric) from public, anon;
grant execute on function public.driver_record_ticket_location(uuid, numeric, numeric, numeric) to authenticated;

-- The customer's proof for one of their own tickets: photos (ids) and the submission position, confirmed tickets only.
create or replace function public.portal_ticket_proof(p_slug text, p_ticket uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v public.portal_accounts%rowtype := private.portal_me(p_slug);
  v_company uuid;
begin
  perform private.portal_require_feature(v.company_id, 'documents');
  select t.company_id into v_company
    from public.delivery_tickets t join public.orders o on o.id = t.order_id
   where t.id = p_ticket and t.company_id = v.company_id and o.customer_id = v.customer_id and t.status = 'accepted';
  if v_company is null then
    return jsonb_build_object('photos', '[]'::jsonb, 'location', null);
  end if;
  return jsonb_build_object(
    'photos', (select coalesce(jsonb_agg(a.id order by a.attached_at), '[]'::jsonb) from public.ticket_attachments a
                where a.company_id = v_company and a.ticket_id = p_ticket and a.status = 'attached'),
    'location', (select jsonb_build_object('lat', l.latitude, 'lng', l.longitude, 'accuracy', l.accuracy_m, 'at', l.recorded_at)
                   from public.ticket_locations l where l.ticket_id = p_ticket and l.company_id = v_company));
end;
$$;
revoke all on function public.portal_ticket_proof(text, uuid) from public, anon;
grant execute on function public.portal_ticket_proof(text, uuid) to authenticated;

-- The storage path of one photo of the customer's own confirmed ticket, or null.
create or replace function public.portal_ticket_photo(p_slug text, p_attachment uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v public.portal_accounts%rowtype := private.portal_me(p_slug);
begin
  perform private.portal_require_feature(v.company_id, 'documents');
  return (select a.object_path
            from public.ticket_attachments a
            join public.delivery_tickets t on t.id = a.ticket_id and t.company_id = a.company_id
            join public.orders o on o.id = t.order_id
           where a.id = p_attachment and a.company_id = v.company_id and a.status = 'attached'
             and t.status = 'accepted' and o.customer_id = v.customer_id);
end;
$$;
revoke all on function public.portal_ticket_photo(text, uuid) from public, anon;
grant execute on function public.portal_ticket_photo(text, uuid) to authenticated;

-- Demo samples: up to five confirmed tickets of a demo company placed at their job site (when it has a position).
create or replace function public.demo_ticket_locations()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_demo uuid := private.demo_owner_company();
  v_n integer;
begin
  if v_demo is null then
    raise exception 'Demo samples are only added to a demo company, by its owner.' using errcode = '42501';
  end if;
  insert into public.ticket_locations (ticket_id, company_id, latitude, longitude, accuracy_m, recorded_at, recorded_by)
  select t.id, t.company_id, s.latitude + 0.0004, s.longitude - 0.0003, 12, t.created_at, null
    from public.delivery_tickets t
    join public.orders o on o.id = t.order_id
    join public.customer_sites s on s.id = o.site_id and s.latitude is not null and s.longitude is not null
   where t.company_id = v_demo and t.status = 'accepted'
     and not exists (select 1 from public.ticket_locations l where l.ticket_id = t.id)
     and (select count(*) from public.ticket_locations l2 where l2.company_id = v_demo) < 5
   order by t.delivered_at desc
   limit 5
  on conflict (ticket_id) do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
revoke all on function public.demo_ticket_locations() from public, anon;
grant execute on function public.demo_ticket_locations() to authenticated;
