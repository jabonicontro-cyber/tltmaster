-- =============================================================================
-- Route Planner core (master plan B10; completion directive 2026-10-25).
--
-- 1. public.company_locations: the company's reusable operational places other than customer job sites (those stay in
--    customer_sites, one source of truth): yards and terminals, quarries, plants and other material pickups, and other
--    places. An address, coordinates, and where the coordinates came from: typed by a person ('manual'), or found by
--    the routing provider's geocoder and then confirmed by a person ('geocoded', with the provider's matched address
--    in geocode_label). Read with dispatch.view or orders.view; written with dispatch.edit or settings.manage.
--    Locations are deactivated, never deleted (saved routes may point at them).
-- 2. Truck routing profile on public.trucks: height, width, length (cm), gross weight (kg) and axle count, each
--    optional. Sent to the truck-routing provider when set; without them the provider's default truck is used and the
--    page says so. Written like every other truck field (fleet.edit, column grants).
-- 3. public.saved_routes and public.saved_route_stops: named routes a dispatcher reuses: ordered stops, each a company
--    location, a customer site or a typed point, with optional time at the stop. Read with dispatch.view; written with
--    dispatch.edit. No distances or provider answers are stored (they are recomputed and may change).
--
-- Additive. Rollback: supabase/rollbacks/20261120002600_route_planner_core.down.sql.
-- =============================================================================

create table public.company_locations (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null default private.current_company_id() references public.companies (id) on delete cascade,
  kind             text not null check (kind in ('yard', 'terminal', 'quarry', 'plant', 'pickup', 'other')),
  name             text not null check (length(btrim(name)) between 1 and 120),
  address_line1    text not null default '' check (length(address_line1) <= 160),
  city             text not null default '' check (length(city) <= 80),
  state            text not null default '' check (length(state) <= 40),
  postal_code      text not null default '' check (length(postal_code) <= 20),
  latitude         numeric(9, 6) check (latitude between -90 and 90),
  longitude        numeric(9, 6) check (longitude between -180 and 180),
  location_source  text not null default '' check (location_source in ('', 'manual', 'geocoded')),
  geocode_label    text not null default '' check (length(geocode_label) <= 300),
  located_at       timestamptz,
  located_by       uuid default auth.uid() references auth.users (id) on delete set null,
  notes            text not null default '' check (length(notes) <= 1000),
  base_id          uuid,
  active           boolean not null default true,
  created_by       uuid default auth.uid() references auth.users (id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (company_id, id),
  foreign key (company_id, base_id) references public.dispatch_bases (company_id, id),
  check ((latitude is null) = (longitude is null)),
  check ((latitude is null) = (location_source = ''))
);
create index company_locations_company on public.company_locations (company_id, kind, name);
create trigger company_locations_touch before update on public.company_locations for each row execute function private.touch_updated_at();

alter table public.company_locations enable row level security;
create policy company_locations_read on public.company_locations for select to authenticated
  using (company_id = (select private.current_company_id())
         and ((select private.has_permission('dispatch.view')) or (select private.has_permission('orders.view'))));
create policy company_locations_insert on public.company_locations for insert to authenticated
  with check (company_id = (select private.current_company_id())
              and ((select private.has_permission('dispatch.edit')) or (select private.has_permission('settings.manage'))));
create policy company_locations_update on public.company_locations for update to authenticated
  using (company_id = (select private.current_company_id())
         and ((select private.has_permission('dispatch.edit')) or (select private.has_permission('settings.manage'))))
  with check (company_id = (select private.current_company_id())
              and ((select private.has_permission('dispatch.edit')) or (select private.has_permission('settings.manage'))));
revoke all on public.company_locations from anon, authenticated;
grant select on public.company_locations to authenticated;
grant insert (kind, name, address_line1, city, state, postal_code, latitude, longitude, location_source, geocode_label, located_at, notes, base_id, active),
      update (kind, name, address_line1, city, state, postal_code, latitude, longitude, location_source, geocode_label, located_at, located_by, notes, base_id, active)
  on public.company_locations to authenticated;

alter table public.trucks
  add column height_cm       integer check (height_cm between 150 and 600),
  add column width_cm        integer check (width_cm between 150 and 400),
  add column length_cm       integer check (length_cm between 300 and 3000),
  add column gross_weight_kg integer check (gross_weight_kg between 1000 and 100000),
  add column axle_count      smallint check (axle_count between 2 and 12);
grant insert (height_cm, width_cm, length_cm, gross_weight_kg, axle_count),
      update (height_cm, width_cm, length_cm, gross_weight_kg, axle_count) on public.trucks to authenticated;

create table public.saved_routes (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null default private.current_company_id() references public.companies (id) on delete cascade,
  name        text not null check (length(btrim(name)) between 1 and 120),
  truck_id    uuid,
  notes       text not null default '' check (length(notes) <= 1000),
  active      boolean not null default true,
  created_by  uuid default auth.uid() references auth.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (company_id, id),
  foreign key (company_id, truck_id) references public.trucks (company_id, id)
);
create trigger saved_routes_touch before update on public.saved_routes for each row execute function private.touch_updated_at();

create table public.saved_route_stops (
  id                   uuid primary key default gen_random_uuid(),
  company_id           uuid not null default private.current_company_id() references public.companies (id) on delete cascade,
  route_id             uuid not null,
  position             smallint not null check (position between 1 and 25),
  company_location_id  uuid,
  customer_site_id     uuid,
  label                text not null default '' check (length(label) <= 160),
  latitude             numeric(9, 6) check (latitude between -90 and 90),
  longitude            numeric(9, 6) check (longitude between -180 and 180),
  service_minutes      smallint not null default 0 check (service_minutes between 0 and 600),
  unique (route_id, position) deferrable initially deferred,
  foreign key (company_id, route_id) references public.saved_routes (company_id, id) on delete cascade,
  foreign key (company_id, company_location_id) references public.company_locations (company_id, id),
  foreign key (company_id, customer_site_id) references public.customer_sites (company_id, id),
  check ((latitude is null) = (longitude is null)),
  -- Exactly one kind of place per stop.
  check (num_nonnulls(company_location_id, customer_site_id, latitude) = 1)
);
create index saved_route_stops_route on public.saved_route_stops (route_id, position);

alter table public.saved_routes enable row level security;
alter table public.saved_route_stops enable row level security;
create policy saved_routes_read on public.saved_routes for select to authenticated
  using (company_id = (select private.current_company_id()) and (select private.has_permission('dispatch.view')));
create policy saved_routes_write on public.saved_routes for all to authenticated
  using (company_id = (select private.current_company_id()) and (select private.has_permission('dispatch.edit')))
  with check (company_id = (select private.current_company_id()) and (select private.has_permission('dispatch.edit')));
create policy saved_route_stops_read on public.saved_route_stops for select to authenticated
  using (company_id = (select private.current_company_id()) and (select private.has_permission('dispatch.view')));
create policy saved_route_stops_write on public.saved_route_stops for all to authenticated
  using (company_id = (select private.current_company_id()) and (select private.has_permission('dispatch.edit')))
  with check (company_id = (select private.current_company_id()) and (select private.has_permission('dispatch.edit')));
revoke all on public.saved_routes, public.saved_route_stops from anon, authenticated;
grant select, delete on public.saved_routes, public.saved_route_stops to authenticated;
grant insert (name, truck_id, notes, active), update (name, truck_id, notes, active) on public.saved_routes to authenticated;
grant insert (route_id, position, company_location_id, customer_site_id, label, latitude, longitude, service_minutes),
      update (position, company_location_id, customer_site_id, label, latitude, longitude, service_minutes)
  on public.saved_route_stops to authenticated;

do $$
begin
  if not (select relrowsecurity from pg_class where oid = 'public.company_locations'::regclass)
     or not (select relrowsecurity from pg_class where oid = 'public.saved_routes'::regclass)
     or not (select relrowsecurity from pg_class where oid = 'public.saved_route_stops'::regclass) then
    raise exception 'Route planner tables must have row level security';
  end if;
end;
$$;
