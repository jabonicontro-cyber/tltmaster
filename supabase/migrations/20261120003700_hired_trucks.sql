-- =============================================================================
-- Hired trucks (B83, owner decisions 2026-10-26): owner-operators and subcontracted haulers.
--
-- * Add-on: a company uses it only when the platform owner switches it on (platform_hired_trucks_set), like the
--   customer portal entitlement. Demo companies get it through Refresh demo data run by the platform team.
-- * Haulers have trucks and drivers (ordinary truck and driver records carrying hauler_id) and dated documents:
--   certificate of insurance (expiry required), W-9, signed subcontractor agreement (optional expiry), and per truck
--   registration and inspection (expiry required). An offer can be sent only when all of them are on file and current.
-- * Offers: dispatch offers one load to one hired truck and driver at a rate set on the offer (per ton, load or hour).
--   The hauler's driver answers in the app with their own sign-in (or dispatch records an answer given by phone).
--   An accepted offer becomes an assignment only when dispatch confirms it, through public.assign_load, so every
--   assignment rule (eligibility, capacity, shifts, conflicts) still applies. A hired truck cannot be assigned any
--   other way.
-- * Pay: accepted tickets of a confirmed offer times the offered rate (computed in the app, unit for unit; nothing is
--   paid or exported).
-- * No texts yet (Twilio keys pending); demo companies never send anything.
--
-- Reversible: supabase/rollbacks/20261120003700_hired_trucks.down.sql
-- =============================================================================

create table private.hired_trucks_entitlements (
  company_id uuid primary key references public.companies (id) on delete cascade,
  entitled   boolean not null default false,
  note       text not null default '',
  set_by     uuid references auth.users (id) on delete set null,
  set_at     timestamptz not null default now()
);
revoke all on private.hired_trucks_entitlements from public, anon, authenticated;

-- Hired trucks are switched on for this company.
create or replace function private.hired_trucks_on(p_company uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select e.entitled from private.hired_trucks_entitlements e where e.company_id = p_company), false);
$$;
revoke all on function private.hired_trucks_on(uuid) from public, anon, authenticated;

create or replace function public.hired_trucks_enabled()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.current_company_id() is not null and private.hired_trucks_on(private.current_company_id());
$$;
revoke all on function public.hired_trucks_enabled() from public, anon;
grant execute on function public.hired_trucks_enabled() to authenticated;

create or replace function public.platform_hired_trucks_set(p_company uuid, p_entitled boolean, p_note text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.require_platform_admin();
  if not exists (select 1 from public.companies where id = p_company) then
    raise exception 'Company not found.' using errcode = 'P0002';
  end if;
  insert into private.hired_trucks_entitlements (company_id, entitled, note, set_by, set_at)
  values (p_company, coalesce(p_entitled, false), left(coalesce(p_note, ''), 500), auth.uid(), now())
  on conflict (company_id) do update set entitled = excluded.entitled, note = excluded.note, set_by = excluded.set_by, set_at = now();
  perform private.platform_log('hired_trucks.entitlement', 'company', p_company::text,
    case when p_entitled then 'Hired trucks switched on' else 'Hired trucks switched off' end, jsonb_build_object('note', p_note));
end;
$$;
revoke all on function public.platform_hired_trucks_set(uuid, boolean, text) from public, anon;
grant execute on function public.platform_hired_trucks_set(uuid, boolean, text) to authenticated;

create or replace function public.platform_hired_trucks_entitlement(p_company uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v private.hired_trucks_entitlements%rowtype;
begin
  perform private.require_platform_admin();
  select * into v from private.hired_trucks_entitlements where company_id = p_company;
  return jsonb_build_object('entitled', coalesce(v.entitled, false), 'note', coalesce(v.note, ''), 'set_at', v.set_at);
end;
$$;
revoke all on function public.platform_hired_trucks_entitlement(uuid) from public, anon;
grant execute on function public.platform_hired_trucks_entitlement(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- Haulers, their documents, trucks and drivers
-- -----------------------------------------------------------------------------

create table public.haulers (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies (id),
  name         text not null check (length(trim(name)) between 1 and 120),
  contact_name text not null default '' check (length(contact_name) <= 120),
  phone        text not null default '' check (length(phone) <= 40),
  email        text not null default '' check (length(email) <= 200),
  notes        text not null default '' check (length(notes) <= 2000),
  active       boolean not null default true,
  created_by   uuid references auth.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  unique (company_id, id)
);
alter table public.haulers enable row level security;
create policy haulers_read on public.haulers for select to authenticated
  using (company_id = (select private.current_company_id())
         and ((select private.has_permission('fleet.view')) or (select private.has_permission('dispatch.view'))));
create trigger a_company_guard before update of company_id on public.haulers for each row execute function private.forbid_company_change();

create table public.hauler_documents (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies (id),
  hauler_id   uuid not null,
  truck_id    uuid,
  kind        text not null check (kind in ('insurance', 'w9', 'agreement', 'registration', 'inspection')),
  reference   text not null default '' check (length(reference) <= 120),
  expires_on  date,
  recorded_by uuid references auth.users (id) on delete set null,
  recorded_at timestamptz not null default clock_timestamp(),
  foreign key (company_id, hauler_id) references public.haulers (company_id, id),
  foreign key (company_id, truck_id) references public.trucks (company_id, id),
  check ((kind in ('registration', 'inspection')) = (truck_id is not null)),
  check (kind not in ('insurance', 'registration', 'inspection') or expires_on is not null)
);
create index hauler_documents_hauler on public.hauler_documents (company_id, hauler_id, kind, recorded_at desc);
alter table public.hauler_documents enable row level security;
create policy hauler_documents_read on public.hauler_documents for select to authenticated
  using (company_id = (select private.current_company_id())
         and ((select private.has_permission('fleet.view')) or (select private.has_permission('dispatch.view'))));
create trigger a_company_guard before update of company_id on public.hauler_documents for each row execute function private.forbid_company_change();

alter table public.trucks add column hauler_id uuid;
alter table public.trucks add constraint trucks_hauler_fk foreign key (company_id, hauler_id) references public.haulers (company_id, id);
alter table public.drivers add column hauler_id uuid;
alter table public.drivers add constraint drivers_hauler_fk foreign key (company_id, hauler_id) references public.haulers (company_id, id);

-- What keeps a hauler (and, when given, one of its trucks) from receiving an offer: missing or expired documents. The
-- newest record of each kind counts. Empty when everything is on file and current on p_on.
create or replace function private.hauler_document_problems(p_company uuid, p_hauler uuid, p_truck uuid, p_on date)
returns text[]
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_problems text[] := '{}';
  v_kind text;
  v_doc public.hauler_documents%rowtype;
  v_label text;
begin
  foreach v_kind in array array['insurance', 'w9', 'agreement', 'registration', 'inspection'] loop
    if v_kind in ('registration', 'inspection') and p_truck is null then continue; end if;
    v_label := case v_kind when 'insurance' then 'certificate of insurance' when 'w9' then 'W-9' when 'agreement' then 'subcontractor agreement'
                           when 'registration' then 'truck registration' else 'truck inspection' end;
    select * into v_doc from public.hauler_documents d
     where d.company_id = p_company and d.hauler_id = p_hauler
       and (v_kind not in ('registration', 'inspection') or d.truck_id = p_truck)
       and d.kind = v_kind
     order by d.recorded_at desc limit 1;
    if not found then
      v_problems := v_problems || ('no ' || v_label || ' on file');
    elsif v_doc.expires_on is not null and v_doc.expires_on < p_on then
      v_problems := v_problems || (v_label || ' expired ' || to_char(v_doc.expires_on, 'Mon DD, YYYY'));
    end if;
  end loop;
  return v_problems;
end;
$$;
revoke all on function private.hauler_document_problems(uuid, uuid, uuid, date) from public, anon, authenticated;

create or replace function private.require_hired_trucks()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
begin
  if not private.hired_trucks_on(v_company) then
    raise exception 'Hired trucks are not switched on for this company.' using errcode = '42501';
  end if;
  return v_company;
end;
$$;
revoke all on function private.require_hired_trucks() from public, anon, authenticated;

create or replace function public.hauler_save(p_id uuid, p_name text, p_contact_name text, p_phone text, p_email text, p_notes text, p_active boolean)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid;
  v_id uuid;
begin
  perform private.require_permission('fleet.edit');
  v_company := private.require_hired_trucks();
  if p_id is null then
    insert into public.haulers (company_id, name, contact_name, phone, email, notes, active, created_by)
    values (v_company, trim(coalesce(p_name, '')), trim(coalesce(p_contact_name, '')), trim(coalesce(p_phone, '')), trim(coalesce(p_email, '')),
            coalesce(p_notes, ''), coalesce(p_active, true), auth.uid())
    returning id into v_id;
  else
    update public.haulers set name = trim(coalesce(p_name, '')), contact_name = trim(coalesce(p_contact_name, '')), phone = trim(coalesce(p_phone, '')),
                              email = trim(coalesce(p_email, '')), notes = coalesce(p_notes, ''), active = coalesce(p_active, true)
     where id = p_id and company_id = v_company
    returning id into v_id;
    if v_id is null then raise exception 'Hauler not found.' using errcode = 'P0002'; end if;
  end if;
  return v_id;
end;
$$;
revoke all on function public.hauler_save(uuid, text, text, text, text, text, boolean) from public, anon;
grant execute on function public.hauler_save(uuid, text, text, text, text, text, boolean) to authenticated;

create or replace function public.hauler_add_truck(p_hauler uuid, p_unit text, p_type public.truck_type, p_plate text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid;
  v_id uuid;
begin
  perform private.require_permission('fleet.edit');
  v_company := private.require_hired_trucks();
  if not exists (select 1 from public.haulers where id = p_hauler and company_id = v_company and active) then
    raise exception 'Hauler not found.' using errcode = 'P0002';
  end if;
  insert into public.trucks (company_id, unit_number, truck_type, license_plate, ownership, hauler_id, created_by)
  values (v_company, trim(coalesce(p_unit, '')), p_type, upper(trim(coalesce(p_plate, ''))), 'rented', p_hauler, auth.uid())
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.hauler_add_truck(uuid, text, public.truck_type, text) from public, anon;
grant execute on function public.hauler_add_truck(uuid, text, public.truck_type, text) to authenticated;

create or replace function public.hauler_add_driver(p_hauler uuid, p_name text, p_phone text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid;
  v_id uuid;
begin
  perform private.require_permission('fleet.edit');
  v_company := private.require_hired_trucks();
  if not exists (select 1 from public.haulers where id = p_hauler and company_id = v_company and active) then
    raise exception 'Hauler not found.' using errcode = 'P0002';
  end if;
  if length(trim(coalesce(p_name, ''))) = 0 then raise exception 'Enter the driver''s name.'; end if;
  insert into public.drivers (company_id, name, phone, hauler_id, created_by)
  values (v_company, trim(p_name), trim(coalesce(p_phone, '')), p_hauler, auth.uid())
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.hauler_add_driver(uuid, text, text) from public, anon;
grant execute on function public.hauler_add_driver(uuid, text, text) to authenticated;

create or replace function public.hauler_record_document(p_hauler uuid, p_truck uuid, p_kind text, p_reference text, p_expires_on date)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid;
  v_id uuid;
begin
  perform private.require_permission('fleet.edit');
  v_company := private.require_hired_trucks();
  if not exists (select 1 from public.haulers where id = p_hauler and company_id = v_company) then
    raise exception 'Hauler not found.' using errcode = 'P0002';
  end if;
  if p_truck is not null and not exists (select 1 from public.trucks where id = p_truck and company_id = v_company and hauler_id = p_hauler) then
    raise exception 'That truck is not one of this hauler''s trucks.';
  end if;
  insert into public.hauler_documents (company_id, hauler_id, truck_id, kind, reference, expires_on, recorded_by)
  values (v_company, p_hauler, p_truck, p_kind, trim(coalesce(p_reference, '')), p_expires_on, auth.uid())
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.hauler_record_document(uuid, uuid, text, text, date) from public, anon;
grant execute on function public.hauler_record_document(uuid, uuid, text, text, date) to authenticated;

-- -----------------------------------------------------------------------------
-- Offers
-- -----------------------------------------------------------------------------

-- The caller's own active driver record in the current company (a hired driver's sign-in), or null.
create or replace function private.my_driver_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select d.id from public.drivers d
   where d.company_id = private.current_company_id() and d.user_id = auth.uid() and d.active
   limit 1;
$$;
revoke all on function private.my_driver_id() from public, anon, authenticated;
grant execute on function private.my_driver_id() to authenticated;

create table public.hauler_offers (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies (id),
  load_id       uuid not null,
  hauler_id     uuid not null,
  truck_id      uuid not null,
  trailer_id    uuid,
  driver_id     uuid not null,
  rate_cents    integer not null check (rate_cents > 0 and rate_cents <= 10000000),
  rate_unit     text not null check (rate_unit in ('ton', 'load', 'hour')),
  note          text not null default '' check (length(note) <= 500),
  status        text not null default 'offered' check (status in ('offered', 'accepted', 'declined', 'withdrawn', 'confirmed')),
  offered_by    uuid references auth.users (id) on delete set null,
  offered_at    timestamptz not null default now(),
  responded_at  timestamptz,
  responded_by  uuid references auth.users (id) on delete set null,
  response_note text not null default '' check (length(response_note) <= 500),
  by_phone      boolean not null default false,
  -- Loads and assignments are deleted only by sample-data removal; their offers go with them.
  assignment_id uuid references public.dispatch_assignments (id) on delete cascade,
  foreign key (company_id, load_id) references public.order_loads (company_id, id) on delete cascade,
  foreign key (company_id, hauler_id) references public.haulers (company_id, id),
  foreign key (company_id, truck_id) references public.trucks (company_id, id),
  foreign key (company_id, trailer_id) references public.trailers (company_id, id),
  foreign key (company_id, driver_id) references public.drivers (company_id, id),
  check ((status = 'confirmed') = (assignment_id is not null))
);
create unique index hauler_offers_one_open on public.hauler_offers (load_id) where status in ('offered', 'accepted');
create index hauler_offers_driver on public.hauler_offers (driver_id, status);
alter table public.hauler_offers enable row level security;
-- Dispatch sees the company's offers; a hired driver sees the offers made to them.
create policy hauler_offers_read on public.hauler_offers for select to authenticated
  using (company_id = (select private.current_company_id())
         and ((select private.has_permission('dispatch.view'))
              or driver_id = (select private.my_driver_id())));
create trigger a_company_guard before update of company_id on public.hauler_offers for each row execute function private.forbid_company_change();

create or replace function public.hauler_offer_send(p_load uuid, p_truck uuid, p_trailer uuid, p_driver uuid, p_rate_cents integer, p_rate_unit text, p_note text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid;
  v_load public.order_loads%rowtype;
  v_hauler uuid;
  v_problems text[];
  v_id uuid;
begin
  perform private.require_permission('dispatch.edit');
  v_company := private.require_hired_trucks();
  select * into v_load from public.order_loads where id = p_load and company_id = v_company for update;
  if not found then raise exception 'Load not found.' using errcode = 'P0002'; end if;
  if v_load.status = 'canceled' then raise exception 'This load is canceled.'; end if;
  if exists (select 1 from public.dispatch_assignments a where a.load_id = p_load and a.status = 'active') then
    raise exception 'This load already has a truck.';
  end if;
  if exists (select 1 from public.hauler_offers o where o.load_id = p_load and o.status in ('offered', 'accepted')) then
    raise exception 'This load already has an open offer. Withdraw it first.';
  end if;
  select t.hauler_id into v_hauler from public.trucks t where t.id = p_truck and t.company_id = v_company and t.active;
  if v_hauler is null then raise exception 'Choose one of a hauler''s trucks.'; end if;
  if not exists (select 1 from public.haulers h where h.id = v_hauler and h.active) then raise exception 'This hauler is inactive.'; end if;
  if not exists (select 1 from public.drivers d where d.id = p_driver and d.company_id = v_company and d.active and d.hauler_id = v_hauler) then
    raise exception 'Choose one of the same hauler''s drivers.';
  end if;
  v_problems := private.hauler_document_problems(v_company, v_hauler, p_truck, v_load.load_date);
  if cardinality(v_problems) > 0 then
    raise exception 'Not eligible: %.', array_to_string(v_problems, '; ');
  end if;
  -- The same eligibility the assignment will need (qualifications, service status, conflicts), so a hauler is never
  -- offered a load that could not be confirmed. Raises with the reason when blocked.
  perform private.check_assignment(v_company, p_truck, p_trailer, p_driver, v_load.load_date, v_load.starts_at, v_load.ends_at, null);
  insert into public.hauler_offers (company_id, load_id, hauler_id, truck_id, trailer_id, driver_id, rate_cents, rate_unit, note, offered_by)
  values (v_company, p_load, v_hauler, p_truck, p_trailer, p_driver, p_rate_cents, p_rate_unit, left(coalesce(p_note, ''), 500), auth.uid())
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.hauler_offer_send(uuid, uuid, uuid, uuid, integer, text, text) from public, anon;
grant execute on function public.hauler_offer_send(uuid, uuid, uuid, uuid, integer, text, text) to authenticated;

-- The hired driver answers in the app; dispatch may record an answer given by phone (by_phone).
create or replace function public.hauler_offer_respond(p_offer uuid, p_accept boolean, p_note text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v_offer public.hauler_offers%rowtype;
  v_driver_user uuid;
  v_by_phone boolean;
begin
  select * into v_offer from public.hauler_offers where id = p_offer and company_id = v_company for update;
  if not found then raise exception 'Offer not found.' using errcode = 'P0002'; end if;
  select d.user_id into v_driver_user from public.drivers d where d.id = v_offer.driver_id;
  if v_driver_user is not null and v_driver_user = auth.uid() then
    v_by_phone := false;
  elsif private.has_permission('dispatch.edit') then
    v_by_phone := true;
  else
    raise exception 'This offer is not yours to answer.' using errcode = '42501';
  end if;
  if v_offer.status <> 'offered' then raise exception 'This offer was already answered or withdrawn.'; end if;
  update public.hauler_offers
     set status = case when p_accept then 'accepted' else 'declined' end, responded_at = now(), responded_by = auth.uid(),
         response_note = left(coalesce(p_note, ''), 500), by_phone = v_by_phone
   where id = p_offer;
  return case when p_accept then 'accepted' else 'declined' end;
end;
$$;
revoke all on function public.hauler_offer_respond(uuid, boolean, text) from public, anon;
grant execute on function public.hauler_offer_respond(uuid, boolean, text) to authenticated;

create or replace function public.hauler_offer_withdraw(p_offer uuid, p_note text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid;
begin
  perform private.require_permission('dispatch.edit');
  v_company := private.require_company();
  update public.hauler_offers set status = 'withdrawn', response_note = left(coalesce(p_note, ''), 500), responded_at = coalesce(responded_at, now())
   where id = p_offer and company_id = v_company and status in ('offered', 'accepted');
  if not found then raise exception 'Only an open offer can be withdrawn.'; end if;
end;
$$;
revoke all on function public.hauler_offer_withdraw(uuid, text) from public, anon;
grant execute on function public.hauler_offer_withdraw(uuid, text) to authenticated;

-- Dispatch turns an accepted offer into the assignment, through assign_load (all of its rules apply). Documents are
-- checked again first: they may have expired since the offer.
create or replace function public.hauler_offer_confirm(p_offer uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid;
  v_offer public.hauler_offers%rowtype;
  v_load public.order_loads%rowtype;
  v_problems text[];
  v_result jsonb;
  v_assignment uuid;
begin
  perform private.require_permission('dispatch.edit');
  v_company := private.require_hired_trucks();
  select * into v_offer from public.hauler_offers where id = p_offer and company_id = v_company for update;
  if not found then raise exception 'Offer not found.' using errcode = 'P0002'; end if;
  if v_offer.status <> 'accepted' then raise exception 'Only an accepted offer can be confirmed.'; end if;
  select * into v_load from public.order_loads where id = v_offer.load_id;
  v_problems := private.hauler_document_problems(v_company, v_offer.hauler_id, v_offer.truck_id, v_load.load_date);
  if cardinality(v_problems) > 0 then
    raise exception 'Not eligible: %.', array_to_string(v_problems, '; ');
  end if;
  perform set_config('tlt.hauler_offer', v_offer.id::text, true);
  v_result := public.assign_load(v_offer.load_id, v_offer.truck_id, v_offer.trailer_id, v_offer.driver_id, 'Hired truck: offer accepted', null);
  perform set_config('tlt.hauler_offer', '', true);
  select a.id into v_assignment from public.dispatch_assignments a where a.load_id = v_offer.load_id and a.status = 'active';
  update public.hauler_offers set status = 'confirmed', assignment_id = v_assignment where id = p_offer;
  return v_assignment;
end;
$$;
revoke all on function public.hauler_offer_confirm(uuid) from public, anon;
grant execute on function public.hauler_offer_confirm(uuid) to authenticated;

-- A hired truck or a hired driver is assigned only through a confirmed offer (never directly on the board, by Plan the
-- day or Smart Dispatch).
create or replace function private.guard_hired_assignment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_offer public.hauler_offers%rowtype;
begin
  if not exists (select 1 from public.trucks t where t.id = new.truck_id and t.hauler_id is not null)
     and not exists (select 1 from public.drivers d where d.id = new.driver_id and d.hauler_id is not null) then
    return new;
  end if;
  select * into v_offer from public.hauler_offers o where o.id::text = current_setting('tlt.hauler_offer', true);
  if not found or v_offer.load_id <> new.load_id or v_offer.truck_id <> new.truck_id or v_offer.driver_id <> new.driver_id
     or v_offer.trailer_id is distinct from new.trailer_id or v_offer.status <> 'accepted' then
    raise exception 'Not eligible: a hired truck is assigned only through an accepted offer (Hired trucks).' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function private.guard_hired_assignment() from public, anon, authenticated;
create trigger dispatch_assignments_hired_guard before insert on public.dispatch_assignments
  for each row execute function private.guard_hired_assignment();

-- The signed-in hired driver's offers with what they need to decide: when, which order, where, how much and the rate.
-- Only their own offers; customer contacts and prices are not included.
create or replace function public.my_hauler_offers()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', o.id, 'status', o.status, 'rate_cents', o.rate_cents, 'rate_unit', o.rate_unit, 'note', o.note,
           'offered_at', o.offered_at, 'responded_at', o.responded_at,
           'load_number', l.load_number, 'load_date', l.load_date, 'start_time', l.start_time, 'end_time', l.end_time,
           'planned_quantity', l.planned_quantity, 'unit_code', l.unit_code,
           'order_number', r.order_number, 'site', concat_ws(', ', nullif(r.site_label, ''), nullif(r.site_city, '')),
           'truck', t.unit_number)
         order by o.offered_at desc), '[]'::jsonb)
  from public.hauler_offers o
  join public.order_loads l on l.id = o.load_id
  join public.orders r on r.id = l.order_id
  join public.trucks t on t.id = o.truck_id
  where o.driver_id = private.my_driver_id()
    and o.status in ('offered', 'accepted', 'confirmed')
    and l.load_date >= (now() at time zone 'utc')::date - 7;
$$;
revoke all on function public.my_hauler_offers() from public, anon;
grant execute on function public.my_hauler_offers() to authenticated;
