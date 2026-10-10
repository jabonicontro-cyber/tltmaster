-- =============================================================================
-- Fleet registry: trucks, trailers, drivers and driver qualifications
--
-- * Company-scoped like every business table: company_id defaults to the
--   caller's company, composite (company_id, x) foreign keys, a_company_guard,
--   RLS on every table, audit triggers.
-- * Capacities and qualifications are never assumed. Unknown values are NULL
--   and shown as unknown; "verified" is stamped by the database with who and
--   when, and cleared whenever the verified values change.
-- * Service status (in service / out of service) changes only through
--   public.set_equipment_service_status(), which requires a reason to take
--   equipment out of service and writes an append-only status history.
-- * Dispatch readiness: public.check_assignment_eligibility() applies the rules
--   documented in section 9 (mirrored by src/lib/fleet/eligibility.ts and
--   parity-tested).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Permissions
-- -----------------------------------------------------------------------------
insert into public.permissions (code, category, description) values
  ('fleet.view',    'Fleet', 'View trucks, trailers, drivers and qualifications'),
  ('fleet.edit',    'Fleet', 'Add and edit trucks, trailers, drivers and qualifications'),
  ('fleet.service', 'Fleet', 'Take trucks and trailers out of service and return them to service');

insert into public.role_permission_defaults (role, permission) values
  ('owner', 'fleet.view'), ('owner', 'fleet.edit'), ('owner', 'fleet.service'),
  ('office', 'fleet.view'), ('office', 'fleet.edit'), ('office', 'fleet.service'),
  ('dispatcher', 'fleet.view'),
  ('mechanic', 'fleet.view'), ('mechanic', 'fleet.service');

insert into public.role_permissions (company_id, role, permission)
select c.id, d.role, d.permission
from public.companies c
cross join public.role_permission_defaults d
where d.permission like 'fleet.%'
on conflict do nothing;

-- -----------------------------------------------------------------------------
-- 2. Types
-- -----------------------------------------------------------------------------
create type public.truck_type as enum (
  'single_axle_dump', 'tandem_axle_dump', 'tri_axle_dump', 'quad_axle_dump', 'tractor', 'other');
create type public.trailer_type as enum (
  'end_dump', 'belly_dump', 'side_dump', 'live_floor', 'pup', 'lowboy', 'flatbed', 'other');
create type public.service_status as enum ('in_service', 'out_of_service');
create type public.weight_unit as enum ('ton', 'lb');
create type public.volume_unit as enum ('cu_yd');
create type public.qualification_kind as enum ('cdl', 'medical_card', 'hazmat', 'twic', 'other');
create type public.cdl_class as enum ('A', 'B', 'C');

-- -----------------------------------------------------------------------------
-- 3. Trucks and trailers
-- -----------------------------------------------------------------------------
create table public.trucks (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid not null default private.current_company_id() references public.companies (id),
  unit_number           text not null check (length(trim(unit_number)) between 1 and 20),
  truck_type            public.truck_type not null,
  make                  text not null default '' check (length(make) <= 60),
  model                 text not null default '' check (length(model) <= 60),
  model_year            integer check (model_year between 1950 and 2100),
  vin                   text not null default '' check (vin = '' or vin ~ '^[A-HJ-NPR-Z0-9]{17}$'),
  license_plate         text not null default '' check (length(license_plate) <= 15),
  plate_state           text not null default '' check (plate_state = '' or plate_state ~ '^[A-Z]{2}$'),
  -- Capacities: NULL = unknown. Value and unit are entered together.
  weight_capacity       numeric(10,3) check (weight_capacity > 0),
  weight_unit           public.weight_unit,
  volume_capacity       numeric(10,3) check (volume_capacity > 0),
  volume_unit           public.volume_unit,
  capacity_source       text not null default '' check (length(capacity_source) <= 200),
  capacity_verified_at  timestamptz,
  capacity_verified_by  uuid references auth.users (id) on delete set null,
  active                boolean not null default true,
  service_status        public.service_status not null default 'in_service',
  out_of_service_reason text not null default '',
  out_of_service_since  timestamptz,
  expected_return_date  date,
  notes                 text not null default '' check (length(notes) <= 4000),
  created_by            uuid default auth.uid() references auth.users (id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_by            uuid references auth.users (id) on delete set null,
  updated_at            timestamptz not null default now(),
  unique (company_id, id),
  constraint trucks_weight_pair check ((weight_capacity is null) = (weight_unit is null)),
  constraint trucks_volume_pair check ((volume_capacity is null) = (volume_unit is null)),
  constraint trucks_verified_needs_capacity check (
    capacity_verified_at is null or weight_capacity is not null or volume_capacity is not null),
  constraint trucks_service check (
    (service_status = 'in_service' and out_of_service_reason = '' and out_of_service_since is null and expected_return_date is null)
    or (service_status = 'out_of_service' and length(trim(out_of_service_reason)) > 0 and out_of_service_since is not null))
);
create unique index trucks_unit_number_key on public.trucks (company_id, lower(trim(unit_number)));

create table public.trailers (
  id                     uuid primary key default gen_random_uuid(),
  company_id             uuid not null default private.current_company_id() references public.companies (id),
  unit_number            text not null check (length(trim(unit_number)) between 1 and 20),
  trailer_type           public.trailer_type not null,
  make                   text not null default '' check (length(make) <= 60),
  model                  text not null default '' check (length(model) <= 60),
  model_year             integer check (model_year between 1950 and 2100),
  vin                    text not null default '' check (vin = '' or vin ~ '^[A-HJ-NPR-Z0-9]{17}$'),
  license_plate          text not null default '' check (length(license_plate) <= 15),
  plate_state            text not null default '' check (plate_state = '' or plate_state ~ '^[A-Z]{2}$'),
  weight_capacity        numeric(10,3) check (weight_capacity > 0),
  weight_unit            public.weight_unit,
  volume_capacity        numeric(10,3) check (volume_capacity > 0),
  volume_unit            public.volume_unit,
  capacity_source        text not null default '' check (length(capacity_source) <= 200),
  capacity_verified_at   timestamptz,
  capacity_verified_by   uuid references auth.users (id) on delete set null,
  -- Truck types that can pull this trailer. Empty = not recorded (unknown).
  compatible_truck_types public.truck_type[] not null default '{}',
  compatibility_notes    text not null default '' check (length(compatibility_notes) <= 1000),
  -- The truck it is usually paired with. The trailer keeps its own status.
  default_truck_id       uuid,
  active                 boolean not null default true,
  service_status         public.service_status not null default 'in_service',
  out_of_service_reason  text not null default '',
  out_of_service_since   timestamptz,
  expected_return_date   date,
  notes                  text not null default '' check (length(notes) <= 4000),
  created_by             uuid default auth.uid() references auth.users (id) on delete set null,
  created_at             timestamptz not null default now(),
  updated_by             uuid references auth.users (id) on delete set null,
  updated_at             timestamptz not null default now(),
  unique (company_id, id),
  constraint trailers_default_truck_fk foreign key (company_id, default_truck_id)
    references public.trucks (company_id, id) on delete set null (default_truck_id),
  constraint trailers_weight_pair check ((weight_capacity is null) = (weight_unit is null)),
  constraint trailers_volume_pair check ((volume_capacity is null) = (volume_unit is null)),
  constraint trailers_verified_needs_capacity check (
    capacity_verified_at is null or weight_capacity is not null or volume_capacity is not null),
  constraint trailers_service check (
    (service_status = 'in_service' and out_of_service_reason = '' and out_of_service_since is null and expected_return_date is null)
    or (service_status = 'out_of_service' and length(trim(out_of_service_reason)) > 0 and out_of_service_since is not null))
);
create unique index trailers_unit_number_key on public.trailers (company_id, lower(trim(unit_number)));
create index trailers_default_truck_idx on public.trailers (default_truck_id);

-- Append-only history of service status changes.
create table public.equipment_status_events (
  id                   uuid primary key default gen_random_uuid(),
  company_id           uuid not null references public.companies (id),
  truck_id             uuid,
  trailer_id           uuid,
  from_status          public.service_status not null,
  to_status            public.service_status not null,
  reason               text not null default '',
  expected_return_date date,
  actor_id             uuid references auth.users (id) on delete set null,
  occurred_at          timestamptz not null default now(),
  constraint equipment_status_events_one check ((truck_id is null) <> (trailer_id is null)),
  constraint equipment_status_events_truck_fk foreign key (company_id, truck_id)
    references public.trucks (company_id, id) on delete cascade,
  constraint equipment_status_events_trailer_fk foreign key (company_id, trailer_id)
    references public.trailers (company_id, id) on delete cascade
);
create index equipment_status_events_truck_idx on public.equipment_status_events (truck_id, occurred_at desc);
create index equipment_status_events_trailer_idx on public.equipment_status_events (trailer_id, occurred_at desc);

-- -----------------------------------------------------------------------------
-- 4. Drivers and qualifications
-- -----------------------------------------------------------------------------
-- A driver may be linked to a person who has an account in the company
-- (company_memberships); the name then comes from that person's profile and
-- is not stored twice. Drivers without an account have their own name.
create table public.drivers (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null default private.current_company_id() references public.companies (id),
  user_id         uuid,
  name            text not null default '' check (length(name) <= 120),
  employee_number text not null default '' check (length(employee_number) <= 20),
  phone           text not null default '' check (length(phone) <= 40),
  hire_date       date,
  active          boolean not null default true,
  notes           text not null default '' check (length(notes) <= 4000),
  created_by      uuid default auth.uid() references auth.users (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_by      uuid references auth.users (id) on delete set null,
  updated_at      timestamptz not null default now(),
  unique (company_id, id),
  constraint drivers_member_fk foreign key (company_id, user_id)
    references public.company_memberships (company_id, user_id) on delete restrict,
  constraint drivers_identity check (user_id is not null or length(trim(name)) > 0)
);
create unique index drivers_user_key on public.drivers (company_id, user_id) where user_id is not null;
create unique index drivers_employee_number_key on public.drivers (company_id, lower(trim(employee_number)))
  where employee_number <> '';

-- License numbers are deliberately not stored (sensitive personal data, and
-- not needed to decide eligibility). Expiry NULL = unknown.
create table public.driver_qualifications (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null default private.current_company_id() references public.companies (id),
  driver_id     uuid not null,
  kind          public.qualification_kind not null,
  cdl_class     public.cdl_class,
  endorsements  text not null default '' check (length(endorsements) <= 60),
  description   text not null default '' check (length(description) <= 120),
  issuing_state text not null default '' check (issuing_state = '' or issuing_state ~ '^[A-Z]{2}$'),
  issued_on     date,
  expires_on    date,
  verified_at   timestamptz,
  verified_by   uuid references auth.users (id) on delete set null,
  notes         text not null default '' check (length(notes) <= 1000),
  created_by    uuid default auth.uid() references auth.users (id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_by    uuid references auth.users (id) on delete set null,
  updated_at    timestamptz not null default now(),
  unique (company_id, id),
  constraint driver_qualifications_driver_fk foreign key (company_id, driver_id)
    references public.drivers (company_id, id) on delete cascade,
  constraint driver_qualifications_class check ((kind = 'cdl') = (cdl_class is not null)),
  constraint driver_qualifications_other check (kind <> 'other' or length(trim(description)) > 0),
  constraint driver_qualifications_dates check (expires_on is null or issued_on is null or expires_on >= issued_on)
);
create index driver_qualifications_driver_idx on public.driver_qualifications (driver_id);
create index driver_qualifications_expiry_idx on public.driver_qualifications (company_id, expires_on);

-- -----------------------------------------------------------------------------
-- 5. Triggers: stamping, verification, audit, company guard
-- -----------------------------------------------------------------------------
-- Verification is recorded by the database, never taken from the client: a
-- client sends any non-null *_verified_at to mean "I verified these values"
-- and null to mean "not verified". The database stamps who and when; when the
-- values are unchanged the original stamp is kept. The app always sends the
-- user's current answer (the form clears it when the values are edited).
create or replace function private.stamp_fleet_row()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_changed boolean;
begin
  if tg_op = 'UPDATE' then
    new.id := old.id;
    new.created_by := old.created_by;
    new.created_at := old.created_at;
    new.updated_by := auth.uid();
    new.updated_at := now();
  else
    new.updated_by := auth.uid();
  end if;

  if tg_table_name in ('trucks', 'trailers') then
    new.unit_number := trim(new.unit_number);
    v_changed := tg_op = 'INSERT'
      or (new.weight_capacity, new.weight_unit, new.volume_capacity, new.volume_unit)
         is distinct from (old.weight_capacity, old.weight_unit, old.volume_capacity, old.volume_unit);
    if new.capacity_verified_at is null then
      new.capacity_verified_by := null;
    elsif v_changed or old.capacity_verified_at is null then
      new.capacity_verified_at := now();
      new.capacity_verified_by := auth.uid();
    else
      new.capacity_verified_at := old.capacity_verified_at;
      new.capacity_verified_by := old.capacity_verified_by;
    end if;
  elsif tg_table_name = 'driver_qualifications' then
    v_changed := tg_op = 'INSERT'
      or (new.kind, new.cdl_class, new.endorsements, new.issuing_state, new.issued_on, new.expires_on, new.driver_id)
         is distinct from (old.kind, old.cdl_class, old.endorsements, old.issuing_state, old.issued_on, old.expires_on, old.driver_id);
    if new.verified_at is null then
      new.verified_by := null;
    elsif v_changed or old.verified_at is null then
      new.verified_at := now();
      new.verified_by := auth.uid();
    else
      new.verified_at := old.verified_at;
      new.verified_by := old.verified_by;
    end if;
  elsif tg_table_name = 'drivers' then
    new.name := trim(new.name);
  end if;
  return new;
end;
$$;

create trigger trucks_stamp before insert or update on public.trucks
  for each row execute function private.stamp_fleet_row();
create trigger trailers_stamp before insert or update on public.trailers
  for each row execute function private.stamp_fleet_row();
create trigger drivers_stamp before insert or update on public.drivers
  for each row execute function private.stamp_fleet_row();
create trigger driver_qualifications_stamp before insert or update on public.driver_qualifications
  for each row execute function private.stamp_fleet_row();

create trigger trucks_audit after insert or update or delete on public.trucks
  for each row execute function private.audit_row_change('truck');
create trigger trailers_audit after insert or update or delete on public.trailers
  for each row execute function private.audit_row_change('trailer');
create trigger drivers_audit after insert or update or delete on public.drivers
  for each row execute function private.audit_row_change('driver');
create trigger driver_qualifications_audit after insert or update or delete on public.driver_qualifications
  for each row execute function private.audit_row_change('driver_qualification');

create trigger a_company_guard before update of company_id on public.trucks
  for each row execute function private.forbid_company_change();
create trigger a_company_guard before update of company_id on public.trailers
  for each row execute function private.forbid_company_change();
create trigger a_company_guard before update of company_id on public.equipment_status_events
  for each row execute function private.forbid_company_change();
create trigger a_company_guard before update of company_id on public.drivers
  for each row execute function private.forbid_company_change();
create trigger a_company_guard before update of company_id on public.driver_qualifications
  for each row execute function private.forbid_company_change();

create trigger equipment_status_events_append_only before update or delete on public.equipment_status_events
  for each row execute function private.prevent_modification();

-- A driver can be linked only to an account that is a member of the same
-- company (the composite FK enforces that) and only once (unique index).

-- -----------------------------------------------------------------------------
-- 6. Row level security and grants
-- -----------------------------------------------------------------------------
alter table public.trucks enable row level security;
alter table public.trailers enable row level security;
alter table public.equipment_status_events enable row level security;
alter table public.drivers enable row level security;
alter table public.driver_qualifications enable row level security;

create policy trucks_read on public.trucks for select to authenticated
  using (company_id = (select private.current_company_id()) and (select private.has_permission('fleet.view')));
create policy trucks_insert on public.trucks for insert to authenticated
  with check (company_id = (select private.current_company_id()) and (select private.has_permission('fleet.edit')));
create policy trucks_update on public.trucks for update to authenticated
  using (company_id = (select private.current_company_id()) and (select private.has_permission('fleet.edit')))
  with check (company_id = (select private.current_company_id()) and (select private.has_permission('fleet.edit')));

create policy trailers_read on public.trailers for select to authenticated
  using (company_id = (select private.current_company_id()) and (select private.has_permission('fleet.view')));
create policy trailers_insert on public.trailers for insert to authenticated
  with check (company_id = (select private.current_company_id()) and (select private.has_permission('fleet.edit')));
create policy trailers_update on public.trailers for update to authenticated
  using (company_id = (select private.current_company_id()) and (select private.has_permission('fleet.edit')))
  with check (company_id = (select private.current_company_id()) and (select private.has_permission('fleet.edit')));

create policy equipment_status_events_read on public.equipment_status_events for select to authenticated
  using (company_id = (select private.current_company_id()) and (select private.has_permission('fleet.view')));

create policy drivers_read on public.drivers for select to authenticated
  using (company_id = (select private.current_company_id()) and (select private.has_permission('fleet.view')));
create policy drivers_insert on public.drivers for insert to authenticated
  with check (company_id = (select private.current_company_id()) and (select private.has_permission('fleet.edit')));
create policy drivers_update on public.drivers for update to authenticated
  using (company_id = (select private.current_company_id()) and (select private.has_permission('fleet.edit')))
  with check (company_id = (select private.current_company_id()) and (select private.has_permission('fleet.edit')));

create policy driver_qualifications_read on public.driver_qualifications for select to authenticated
  using (company_id = (select private.current_company_id()) and (select private.has_permission('fleet.view')));
create policy driver_qualifications_insert on public.driver_qualifications for insert to authenticated
  with check (company_id = (select private.current_company_id()) and (select private.has_permission('fleet.edit')));
create policy driver_qualifications_update on public.driver_qualifications for update to authenticated
  using (company_id = (select private.current_company_id()) and (select private.has_permission('fleet.edit')))
  with check (company_id = (select private.current_company_id()) and (select private.has_permission('fleet.edit')));
-- Removing a mistaken qualification entry is allowed (audited).
create policy driver_qualifications_delete on public.driver_qualifications for delete to authenticated
  using (company_id = (select private.current_company_id()) and (select private.has_permission('fleet.edit')));

revoke all on public.trucks, public.trailers, public.equipment_status_events, public.drivers,
  public.driver_qualifications from anon, authenticated;
grant select on public.trucks, public.trailers, public.equipment_status_events, public.drivers,
  public.driver_qualifications to authenticated;

-- Service status columns are not writable by clients: they change only
-- through set_equipment_service_status(). Trucks and trailers are never
-- deleted (deactivate instead).
grant insert (unit_number, truck_type, make, model, model_year, vin, license_plate, plate_state,
  weight_capacity, weight_unit, volume_capacity, volume_unit, capacity_source, capacity_verified_at,
  active, notes)
  on public.trucks to authenticated;
grant update (unit_number, truck_type, make, model, model_year, vin, license_plate, plate_state,
  weight_capacity, weight_unit, volume_capacity, volume_unit, capacity_source, capacity_verified_at,
  active, notes)
  on public.trucks to authenticated;
grant insert (unit_number, trailer_type, make, model, model_year, vin, license_plate, plate_state,
  weight_capacity, weight_unit, volume_capacity, volume_unit, capacity_source, capacity_verified_at,
  compatible_truck_types, compatibility_notes, default_truck_id, active, notes)
  on public.trailers to authenticated;
grant update (unit_number, trailer_type, make, model, model_year, vin, license_plate, plate_state,
  weight_capacity, weight_unit, volume_capacity, volume_unit, capacity_source, capacity_verified_at,
  compatible_truck_types, compatibility_notes, default_truck_id, active, notes)
  on public.trailers to authenticated;
grant insert (user_id, name, employee_number, phone, hire_date, active, notes)
  on public.drivers to authenticated;
grant update (user_id, name, employee_number, phone, hire_date, active, notes)
  on public.drivers to authenticated;
grant insert (driver_id, kind, cdl_class, endorsements, description, issuing_state, issued_on, expires_on,
  verified_at, notes)
  on public.driver_qualifications to authenticated;
grant update (kind, cdl_class, endorsements, description, issuing_state, issued_on, expires_on,
  verified_at, notes)
  on public.driver_qualifications to authenticated;
grant delete on public.driver_qualifications to authenticated;

grant all on public.trucks, public.trailers, public.equipment_status_events, public.drivers,
  public.driver_qualifications to service_role;

-- -----------------------------------------------------------------------------
-- 7. Lists
-- -----------------------------------------------------------------------------
-- Name, membership state and role of a person in the caller's company (the
-- same people user_directory() lists; no email). Lets the driver list show a
-- linked driver's name to people who cannot read profiles.
create or replace function private.member_summary(p_user_id uuid)
returns table (full_name text, active boolean, role public.app_role)
language sql
stable
security definer
set search_path = ''
as $$
  select p.full_name, m.active, m.role
  from public.company_memberships m
  join public.profiles p on p.id = m.user_id
  where m.user_id = p_user_id
    and m.company_id = private.current_company_id()
$$;

-- Drivers with their display name (account name when linked).
create view public.driver_list
with (security_invoker = true) as
select
  d.id,
  d.company_id,
  d.user_id,
  coalesce(nullif(trim(ms.full_name), ''), nullif(d.name, ''), 'Unnamed driver') as display_name,
  d.name,
  d.employee_number,
  d.phone,
  d.hire_date,
  d.active,
  d.notes,
  d.created_at,
  d.updated_at,
  ms.active as account_active,
  ms.role as account_role
from public.drivers d
left join lateral private.member_summary(d.user_id) ms on d.user_id is not null;

revoke all on public.driver_list from anon, authenticated;
grant select on public.driver_list to authenticated;
grant select on public.driver_list to service_role;

-- -----------------------------------------------------------------------------
-- 8. Service status
-- -----------------------------------------------------------------------------
create or replace function public.set_equipment_service_status(
  p_kind text,
  p_id uuid,
  p_status public.service_status,
  p_reason text default '',
  p_expected_return date default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid;
  v_reason  text := private.clean_text(p_reason, 500, 'Reason');
  v_unit    text;
  v_from    public.service_status;
begin
  perform private.require_permission('fleet.service');
  v_company := private.require_company();

  if p_kind not in ('truck', 'trailer') then
    raise exception 'Unknown equipment kind.';
  end if;
  if p_status is null then
    raise exception 'Choose a status.';
  end if;
  if p_status = 'out_of_service' and length(v_reason) = 0 then
    raise exception 'Enter a reason for taking the equipment out of service.';
  end if;
  if p_status = 'in_service' and p_expected_return is not null then
    raise exception 'An expected return date only applies to equipment that is out of service.';
  end if;
  if p_expected_return is not null and p_expected_return < private.business_today(v_company) then
    raise exception 'The expected return date cannot be in the past.';
  end if;

  if p_kind = 'truck' then
    select unit_number, service_status into v_unit, v_from
    from public.trucks where id = p_id and company_id = v_company for update;
  else
    select unit_number, service_status into v_unit, v_from
    from public.trailers where id = p_id and company_id = v_company for update;
  end if;
  if v_unit is null then
    raise exception 'Equipment not found.';
  end if;
  if v_from = p_status then
    raise exception '% % is already %.', initcap(p_kind), v_unit, replace(p_status::text, '_', ' ');
  end if;

  if p_kind = 'truck' then
    update public.trucks set
      service_status        = p_status,
      out_of_service_reason = case when p_status = 'out_of_service' then v_reason else '' end,
      out_of_service_since  = case when p_status = 'out_of_service' then now() end,
      expected_return_date  = p_expected_return
    where id = p_id;
  else
    update public.trailers set
      service_status        = p_status,
      out_of_service_reason = case when p_status = 'out_of_service' then v_reason else '' end,
      out_of_service_since  = case when p_status = 'out_of_service' then now() end,
      expected_return_date  = p_expected_return
    where id = p_id;
  end if;

  insert into public.equipment_status_events (company_id, truck_id, trailer_id, from_status, to_status, reason,
                                               expected_return_date, actor_id)
  values (v_company,
          case when p_kind = 'truck' then p_id end,
          case when p_kind = 'trailer' then p_id end,
          v_from, p_status, v_reason, p_expected_return, auth.uid());

  return jsonb_build_object('id', p_id, 'service_status', p_status);
end;
$$;

-- -----------------------------------------------------------------------------
-- 9. Dispatch readiness (mirrored in src/lib/fleet/eligibility.ts)
--
--   active     — the record is not deactivated (administrative).
--   available  — active, and for trucks/trailers also in service.
--   eligible   — available, and for a given date and combination:
--     * trailer: its recorded compatible truck types include the truck's type
--       (empty list = unknown → warning, not a pass);
--     * driver: a verified, unexpired CDL of the required class and a verified,
--       unexpired medical card on that date. Required class: A when a trailer
--       is included, otherwise B (A also qualifies). A qualification without an
--       expiry date is "expiry unknown" and does not qualify.
--   Warnings (do not block): capacity unknown or unverified, compatibility not
--   recorded, a qualification expiring within 30 days.
--
-- Blocker reason for a required qualification, first that applies:
--   missing (none recorded) → class_insufficient (only lower classes) →
--   expired (none unexpired) → expiry_unknown → unverified.
-- -----------------------------------------------------------------------------
create or replace function private.cdl_class_rank(p_class public.cdl_class)
returns integer
language sql
immutable
set search_path = ''
as $$
  select case p_class when 'A' then 3 when 'B' then 2 when 'C' then 1 else 0 end
$$;

-- Status of one required qualification for a driver on a date.
-- Returns 'ok', 'missing', 'class_insufficient', 'expired', 'expiry_unknown' or 'unverified'.
create or replace function private.qualification_check(
  p_driver_id uuid,
  p_kind public.qualification_kind,
  p_min_class public.cdl_class,
  p_on date
)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  with q as (
    select * from public.driver_qualifications
    where driver_id = p_driver_id and kind = p_kind
  ),
  classed as (
    select * from q
    where p_min_class is null or private.cdl_class_rank(cdl_class) >= private.cdl_class_rank(p_min_class)
  )
  select case
    when not exists (select 1 from q) then 'missing'
    when not exists (select 1 from classed) then 'class_insufficient'
    when exists (select 1 from classed where verified_at is not null and expires_on >= p_on) then 'ok'
    when not exists (select 1 from classed where expires_on is null or expires_on >= p_on) then 'expired'
    when not exists (select 1 from classed where expires_on >= p_on) then 'expiry_unknown'
    else 'unverified'
  end
$$;

create or replace function public.check_assignment_eligibility(
  p_truck_id uuid,
  p_trailer_id uuid,
  p_driver_id uuid,
  p_on date default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company  uuid;
  v_on       date;
  v_truck    public.trucks%rowtype;
  v_trailer  public.trailers%rowtype;
  v_driver   public.drivers%rowtype;
  v_blockers text[] := '{}';
  v_warnings text[] := '{}';
  v_state    text;
  v_min      public.cdl_class;
  v_soon     date;
begin
  perform private.require_permission('fleet.view');
  v_company := private.require_company();
  v_on := coalesce(p_on, private.business_today(v_company));
  v_soon := v_on + 30;

  if p_truck_id is null and p_trailer_id is null and p_driver_id is null then
    raise exception 'Choose a truck, a trailer or a driver.';
  end if;

  if p_truck_id is not null then
    select * into v_truck from public.trucks where id = p_truck_id and company_id = v_company;
    if not found then raise exception 'Truck not found.'; end if;
    if not v_truck.active then v_blockers := v_blockers || 'truck_inactive'::text; end if;
    if v_truck.service_status = 'out_of_service' then v_blockers := v_blockers || 'truck_out_of_service'::text; end if;
    if v_truck.weight_capacity is null and v_truck.volume_capacity is null then
      v_warnings := v_warnings || 'truck_capacity_unknown'::text;
    elsif v_truck.capacity_verified_at is null then
      v_warnings := v_warnings || 'truck_capacity_unverified'::text;
    end if;
  end if;

  if p_trailer_id is not null then
    select * into v_trailer from public.trailers where id = p_trailer_id and company_id = v_company;
    if not found then raise exception 'Trailer not found.'; end if;
    if not v_trailer.active then v_blockers := v_blockers || 'trailer_inactive'::text; end if;
    if v_trailer.service_status = 'out_of_service' then v_blockers := v_blockers || 'trailer_out_of_service'::text; end if;
    if v_trailer.weight_capacity is null and v_trailer.volume_capacity is null then
      v_warnings := v_warnings || 'trailer_capacity_unknown'::text;
    elsif v_trailer.capacity_verified_at is null then
      v_warnings := v_warnings || 'trailer_capacity_unverified'::text;
    end if;
    if p_truck_id is not null then
      if cardinality(v_trailer.compatible_truck_types) = 0 then
        v_warnings := v_warnings || 'trailer_compatibility_unknown'::text;
      elsif not (v_truck.truck_type = any (v_trailer.compatible_truck_types)) then
        v_blockers := v_blockers || 'trailer_incompatible'::text;
      end if;
    end if;
  end if;

  if p_driver_id is not null then
    select * into v_driver from public.drivers where id = p_driver_id and company_id = v_company;
    if not found then raise exception 'Driver not found.'; end if;
    if not v_driver.active then v_blockers := v_blockers || 'driver_inactive'::text; end if;

    v_min := case when p_trailer_id is not null then 'A'::public.cdl_class else 'B'::public.cdl_class end;
    v_state := private.qualification_check(p_driver_id, 'cdl', v_min, v_on);
    if v_state <> 'ok' then
      v_blockers := v_blockers || ('cdl_' || v_state);
    elsif not exists (select 1 from public.driver_qualifications
                      where driver_id = p_driver_id and kind = 'cdl' and verified_at is not null
                        and private.cdl_class_rank(cdl_class) >= private.cdl_class_rank(v_min)
                        and expires_on > v_soon) then
      v_warnings := v_warnings || 'cdl_expiring_soon'::text;
    end if;

    v_state := private.qualification_check(p_driver_id, 'medical_card', null, v_on);
    if v_state <> 'ok' then
      v_blockers := v_blockers || ('medical_card_' || v_state);
    elsif not exists (select 1 from public.driver_qualifications
                      where driver_id = p_driver_id and kind = 'medical_card' and verified_at is not null
                        and expires_on > v_soon) then
      v_warnings := v_warnings || 'medical_card_expiring_soon'::text;
    end if;
  end if;

  return jsonb_build_object(
    'on', v_on,
    'eligible', cardinality(v_blockers) = 0,
    'blockers', to_jsonb(v_blockers),
    'warnings', to_jsonb(v_warnings));
end;
$$;

-- -----------------------------------------------------------------------------
-- 10. Grants for functions
-- -----------------------------------------------------------------------------
revoke execute on function
  public.set_equipment_service_status(text, uuid, public.service_status, text, date),
  public.check_assignment_eligibility(uuid, uuid, uuid, date)
from public, anon;
grant execute on function
  public.set_equipment_service_status(text, uuid, public.service_status, text, date),
  public.check_assignment_eligibility(uuid, uuid, uuid, date)
to authenticated;

-- Used by the driver_list view, which runs as the caller.
revoke execute on function private.member_summary(uuid) from public, anon;
grant execute on function private.member_summary(uuid) to authenticated;

revoke execute on function
  private.stamp_fleet_row(),
  private.cdl_class_rank(public.cdl_class),
  private.qualification_check(uuid, public.qualification_kind, public.cdl_class, date)
from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 11. Fleet history: people who can view the fleet can read the audit entries
--     of fleet records (only those) in their own company.
-- -----------------------------------------------------------------------------
create policy audit_read_fleet on public.audit_events for select to authenticated
  using (
    company_id = (select private.current_company_id())
    and entity_type in ('truck', 'trailer', 'driver', 'driver_qualification')
    and (select private.has_permission('fleet.view'))
  );

-- -----------------------------------------------------------------------------
-- 12. Verification
-- -----------------------------------------------------------------------------
do $$
begin
  if (select count(*) from public.role_permissions where permission = 'fleet.view')
     <> 4 * (select count(*) from public.companies) then
    raise exception 'fleet.view was not granted to owner, office, dispatcher and mechanic in every company';
  end if;
end;
$$;
