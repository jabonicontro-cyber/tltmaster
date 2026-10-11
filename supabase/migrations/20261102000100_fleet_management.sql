-- =============================================================================
-- Fleet management: vehicle documents, ownership, and truck–driver assignment
-- history with an atomic reassign.
--
-- * public.vehicle_documents — registration, insurance, inspection certificates,
--   permits, lease/title and other documents per truck or trailer: reference
--   number, issuing authority, issue and expiry dates. Metadata only (no file
--   upload yet). Read with fleet.view; add/edit/archive with fleet.edit. Never
--   deleted: a replaced document is archived so history stays.
-- * trucks.ownership / trailers.ownership — owned, financed, leased or rented;
--   NULL = not recorded (shown as missing, never assumed).
-- * public.truck_assignment_events — append-only history of a driver's primary
--   truck being assigned or removed, written by a trigger on drivers whatever
--   the path. Read with fleet.view.
-- * public.assign_truck_driver(truck, driver) — sets (or with NULL removes) the
--   driver whose primary truck this is, in one step: the truck's previous holder
--   is unassigned and the new driver's previous truck released. Needs
--   fleet.assign; same company only. A primary truck is the truck a driver
--   normally uses; it does not mean the truck is in service or dispatch-ready.
--
-- Service status and maintenance restrictions are unchanged: Fleet still uses
-- set_equipment_service_status(), and the maintenance clearance trigger still
-- refuses to return a restricted truck to service.
--
-- Also: work_order_events.created_at defaults to clock_timestamp() (ordering fix).
--
-- Additive: no existing row changes. Depends on 20261013000100 (fleet registry)
-- and 20261031000100 (employees: drivers.primary_truck_id,
-- set_driver_primary_truck). Rollback: supabase/rollbacks/20261102000100_fleet_management.down.sql
-- =============================================================================

-- Maintenance history (20261101000100): stamp each event with the moment it is
-- written, so two changes in one transaction keep their order (the driver's
-- notice shows the latest of "scheduled" / "rescheduled" / "canceled").
alter table public.work_order_events alter column created_at set default clock_timestamp();

-- -----------------------------------------------------------------------------
-- Ownership
-- -----------------------------------------------------------------------------
alter table public.trucks add column ownership text
  check (ownership in ('owned', 'financed', 'leased', 'rented'));
alter table public.trailers add column ownership text
  check (ownership in ('owned', 'financed', 'leased', 'rented'));
grant insert (ownership), update (ownership) on public.trucks to authenticated;
grant insert (ownership), update (ownership) on public.trailers to authenticated;

-- -----------------------------------------------------------------------------
-- Vehicle documents
-- -----------------------------------------------------------------------------
create table public.vehicle_documents (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null default private.current_company_id() references public.companies (id),
  truck_id           uuid,
  trailer_id         uuid,
  kind               text not null check (kind in ('registration', 'insurance', 'inspection', 'permit', 'lease', 'title', 'other')),
  title              text not null default '' check (length(title) <= 120),
  reference_number   text not null default '' check (length(reference_number) <= 80),
  issuing_authority  text not null default '' check (length(issuing_authority) <= 120),
  issued_on          date,
  expires_on         date,
  notes              text not null default '' check (length(notes) <= 2000),
  archived_at        timestamptz,
  archived_by        uuid references auth.users (id) on delete set null,
  submission_key     uuid,
  created_by         uuid default auth.uid() references auth.users (id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_by         uuid references auth.users (id) on delete set null,
  updated_at         timestamptz not null default now(),
  foreign key (company_id, truck_id) references public.trucks (company_id, id),
  foreign key (company_id, trailer_id) references public.trailers (company_id, id),
  constraint vehicle_documents_one_vehicle check (num_nonnulls(truck_id, trailer_id) = 1),
  constraint vehicle_documents_dates check (expires_on is null or issued_on is null or expires_on >= issued_on),
  constraint vehicle_documents_other_titled check (kind <> 'other' or length(trim(title)) > 0)
);
create index vehicle_documents_truck_idx on public.vehicle_documents (company_id, truck_id) where truck_id is not null;
create index vehicle_documents_trailer_idx on public.vehicle_documents (company_id, trailer_id) where trailer_id is not null;
create index vehicle_documents_expiry_idx on public.vehicle_documents (company_id, expires_on) where archived_at is null;
create unique index vehicle_documents_submission_key on public.vehicle_documents (company_id, submission_key)
  where submission_key is not null;

create or replace function private.stamp_vehicle_document()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_by := auth.uid();
  new.updated_at := now();
  new.title := trim(new.title);
  new.reference_number := trim(new.reference_number);
  new.issuing_authority := trim(new.issuing_authority);
  if tg_op = 'UPDATE' then
    -- The vehicle a document belongs to never changes; archiving is one-way.
    if new.truck_id is distinct from old.truck_id or new.trailer_id is distinct from old.trailer_id then
      raise exception 'A document cannot be moved to another vehicle. Add it to that vehicle instead.' using errcode = 'P0001';
    end if;
    if old.archived_at is not null and new.archived_at is null then
      raise exception 'An archived document cannot be restored. Add a new one instead.' using errcode = 'P0001';
    end if;
    if new.archived_at is not null and old.archived_at is null then
      new.archived_by := auth.uid();
    end if;
  end if;
  return new;
end;
$$;
create trigger vehicle_documents_stamp before insert or update on public.vehicle_documents
  for each row execute function private.stamp_vehicle_document();
create trigger a_company_guard before update of company_id on public.vehicle_documents
  for each row execute function private.forbid_company_change();
create trigger vehicle_documents_audit after insert or update or delete on public.vehicle_documents
  for each row execute function private.audit_row_change('vehicle_document');

alter table public.vehicle_documents enable row level security;
create policy vehicle_documents_read on public.vehicle_documents for select to authenticated
  using (company_id = (select private.current_company_id()) and (select private.has_permission('fleet.view')));
create policy vehicle_documents_insert on public.vehicle_documents for insert to authenticated
  with check (company_id = (select private.current_company_id()) and (select private.has_permission('fleet.edit')));
create policy vehicle_documents_update on public.vehicle_documents for update to authenticated
  using (company_id = (select private.current_company_id()) and (select private.has_permission('fleet.edit')))
  with check (company_id = (select private.current_company_id()) and (select private.has_permission('fleet.edit')));

revoke all on public.vehicle_documents from anon, authenticated;
grant select on public.vehicle_documents to authenticated;
grant insert (truck_id, trailer_id, kind, title, reference_number, issuing_authority, issued_on, expires_on, notes, submission_key)
  on public.vehicle_documents to authenticated;
grant update (kind, title, reference_number, issuing_authority, issued_on, expires_on, notes, archived_at)
  on public.vehicle_documents to authenticated;
grant all on public.vehicle_documents to service_role;

-- -----------------------------------------------------------------------------
-- Assignment history
-- -----------------------------------------------------------------------------
create table public.truck_assignment_events (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies (id),
  truck_id    uuid not null,
  driver_id   uuid not null,
  action      text not null check (action in ('assigned', 'unassigned')),
  actor_id    uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default clock_timestamp(),
  foreign key (company_id, truck_id) references public.trucks (company_id, id),
  foreign key (company_id, driver_id) references public.drivers (company_id, id)
);
create index truck_assignment_events_truck_idx on public.truck_assignment_events (company_id, truck_id, created_at desc);
create index truck_assignment_events_driver_idx on public.truck_assignment_events (company_id, driver_id, created_at desc);
create trigger a_company_guard before update of company_id on public.truck_assignment_events
  for each row execute function private.forbid_company_change();

alter table public.truck_assignment_events enable row level security;
create policy truck_assignment_events_read on public.truck_assignment_events for select to authenticated
  using (company_id = (select private.current_company_id()) and (select private.has_permission('fleet.view')));
revoke all on public.truck_assignment_events from anon, authenticated;
grant select on public.truck_assignment_events to authenticated;
grant all on public.truck_assignment_events to service_role;

-- Written whenever a driver's primary truck changes, by any path. Runs with the
-- table owner's rights because app users cannot insert history themselves.
create or replace function private.record_truck_assignment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and old.primary_truck_id is not null
     and old.primary_truck_id is distinct from new.primary_truck_id then
    insert into public.truck_assignment_events (company_id, truck_id, driver_id, action, actor_id)
    values (new.company_id, old.primary_truck_id, new.id, 'unassigned', auth.uid());
  end if;
  if new.primary_truck_id is not null
     and (tg_op = 'INSERT' or old.primary_truck_id is distinct from new.primary_truck_id) then
    insert into public.truck_assignment_events (company_id, truck_id, driver_id, action, actor_id)
    values (new.company_id, new.primary_truck_id, new.id, 'assigned', auth.uid());
  end if;
  return null;
end;
$$;
revoke execute on function private.record_truck_assignment() from public, anon, authenticated;
create trigger drivers_truck_assignment_history after insert or update of primary_truck_id on public.drivers
  for each row execute function private.record_truck_assignment();

/**
 * Make p_driver_id the driver whose primary truck is p_truck_id (NULL removes the
 * truck's driver). The previous holder is unassigned and the new driver's
 * previous primary truck released, in one transaction. Needs fleet.assign.
 */
create or replace function public.assign_truck_driver(p_truck_id uuid, p_driver_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v_unit    text;
  v_holder  uuid;
  v_name    text;
begin
  perform private.require_permission('fleet.assign');
  select unit_number into v_unit from public.trucks where id = p_truck_id and company_id = v_company and active for update;
  if v_unit is null then
    raise exception 'Truck not found or not active.' using errcode = 'P0002';
  end if;
  if p_driver_id is not null then
    select name into v_name from public.drivers where id = p_driver_id and company_id = v_company and active for update;
    if v_name is null then
      raise exception 'Driver not found or not active.' using errcode = 'P0002';
    end if;
  end if;

  select id into v_holder from public.drivers
  where company_id = v_company and primary_truck_id = p_truck_id and active
  for update;
  if v_holder is not distinct from p_driver_id then
    return jsonb_build_object('changed', false, 'unit_number', v_unit);
  end if;

  if v_holder is not null then
    update public.drivers set primary_truck_id = null where id = v_holder;
  end if;
  if p_driver_id is not null then
    update public.drivers set primary_truck_id = p_truck_id where id = p_driver_id;
  end if;
  return jsonb_build_object('changed', true, 'unit_number', v_unit, 'previous_driver_id', v_holder, 'driver_id', p_driver_id);
end;
$$;
revoke execute on function public.assign_truck_driver(uuid, uuid) from public, anon;
grant execute on function public.assign_truck_driver(uuid, uuid) to authenticated;
