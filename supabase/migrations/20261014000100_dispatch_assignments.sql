-- =============================================================================
-- Dispatch assignments (N4)
--
-- Data model decision (docs/IMPLEMENTATION_PLAN.md §5c): orders had a scheduled
-- date range and a daily time window, but no loads and no per-truck times.
-- This migration adds
--   * order_loads           — planned trips of an order on one day, with an
--                             explicit start and end time;
--   * dispatch_assignments  — truck (+ trailer) + driver for one load. Rows are
--                             never deleted or rewritten: reassigning cancels the
--                             active row and inserts a new one.
-- Overlap = half-open intervals [starts_at, ends_at) of active assignments for
-- the same truck, trailer or driver. Enforced by exclusion constraints, so
-- concurrent requests cannot double-book.
-- All writes go through SECURITY DEFINER functions that resolve the caller's
-- company, re-check permissions and reuse the fleet eligibility rules.
-- Additive: no existing row is changed. To reverse, drop the two tables, the
-- functions and the trigger on orders defined here, and the dispatch.*
-- permissions.
-- =============================================================================

create extension if not exists btree_gist with schema extensions;

-- -----------------------------------------------------------------------------
-- 1. Permissions
-- -----------------------------------------------------------------------------
insert into public.permissions (code, category, description) values
  ('dispatch.view', 'Dispatch', 'View the dispatch board, loads and assignments'),
  ('dispatch.edit', 'Dispatch', 'Plan loads and assign, reassign or cancel trucks, trailers and drivers');

insert into public.role_permission_defaults (role, permission) values
  ('owner', 'dispatch.view'), ('owner', 'dispatch.edit'),
  ('office', 'dispatch.view'), ('office', 'dispatch.edit'),
  ('dispatcher', 'dispatch.view'), ('dispatcher', 'dispatch.edit');

insert into public.role_permissions (company_id, role, permission)
select c.id, d.role, d.permission
from public.companies c
cross join public.role_permission_defaults d
where d.permission like 'dispatch.%'
on conflict do nothing;

-- -----------------------------------------------------------------------------
-- 2. Tables
-- -----------------------------------------------------------------------------
create type public.load_status as enum ('planned', 'canceled');
create type public.assignment_status as enum ('active', 'canceled');

create table public.order_loads (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references public.companies (id),
  order_id         uuid not null,
  load_number      integer not null check (load_number > 0),
  load_date        date not null,
  start_time       time not null,
  end_time         time not null,
  -- Derived by the functions from load_date + time in the company's timezone.
  starts_at        timestamptz not null,
  ends_at          timestamptz not null,
  planned_quantity numeric(12,3) check (planned_quantity > 0),
  unit_code        text,
  notes            text not null default '' check (length(notes) <= 1000),
  status           public.load_status not null default 'planned',
  cancel_reason    text not null default '',
  canceled_at      timestamptz,
  canceled_by      uuid references auth.users (id) on delete set null,
  created_by       uuid references auth.users (id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_by       uuid references auth.users (id) on delete set null,
  updated_at       timestamptz not null default now(),
  unique (company_id, id),
  unique (order_id, load_number),
  constraint order_loads_order_fk foreign key (company_id, order_id)
    references public.orders (company_id, id) on delete cascade,
  constraint order_loads_unit_fk foreign key (company_id, unit_code)
    references public.units_of_measure (company_id, code),
  constraint order_loads_quantity_pair check ((planned_quantity is null) = (unit_code is null)),
  constraint order_loads_times check (end_time > start_time and ends_at > starts_at),
  constraint order_loads_canceled check (
    (status = 'planned' and canceled_at is null and cancel_reason = '')
    or (status = 'canceled' and canceled_at is not null and length(trim(cancel_reason)) > 0))
);
create index order_loads_date_idx on public.order_loads (company_id, load_date);
create index order_loads_order_idx on public.order_loads (order_id);

create table public.dispatch_assignments (
  id                     uuid primary key default gen_random_uuid(),
  company_id             uuid not null references public.companies (id),
  load_id                uuid not null,
  order_id               uuid not null,
  truck_id               uuid not null,
  trailer_id             uuid,
  driver_id              uuid not null,
  starts_at              timestamptz not null,
  ends_at                timestamptz not null,
  status                 public.assignment_status not null default 'active',
  note                   text not null default '' check (length(note) <= 500),
  -- Eligibility warnings accepted when the assignment was made (e.g. capacity unknown).
  warnings               text[] not null default '{}',
  replaces_assignment_id uuid references public.dispatch_assignments (id),
  cancel_reason          text not null default '',
  canceled_at            timestamptz,
  canceled_by            uuid references auth.users (id) on delete set null,
  created_by             uuid references auth.users (id) on delete set null,
  created_at             timestamptz not null default now(),
  unique (company_id, id),
  constraint dispatch_assignments_load_fk foreign key (company_id, load_id)
    references public.order_loads (company_id, id) on delete cascade,
  constraint dispatch_assignments_order_fk foreign key (company_id, order_id)
    references public.orders (company_id, id) on delete cascade,
  constraint dispatch_assignments_truck_fk foreign key (company_id, truck_id)
    references public.trucks (company_id, id),
  constraint dispatch_assignments_trailer_fk foreign key (company_id, trailer_id)
    references public.trailers (company_id, id),
  constraint dispatch_assignments_driver_fk foreign key (company_id, driver_id)
    references public.drivers (company_id, id),
  constraint dispatch_assignments_times check (ends_at > starts_at),
  constraint dispatch_assignments_canceled check (
    (status = 'active' and canceled_at is null and cancel_reason = '')
    or (status = 'canceled' and canceled_at is not null and length(trim(cancel_reason)) > 0)),
  -- No double-booking, even under concurrent requests.
  constraint dispatch_assignments_truck_overlap exclude using gist (
    truck_id with =, tstzrange(starts_at, ends_at, '[)') with &&) where (status = 'active'),
  constraint dispatch_assignments_trailer_overlap exclude using gist (
    trailer_id with =, tstzrange(starts_at, ends_at, '[)') with &&) where (status = 'active' and trailer_id is not null),
  constraint dispatch_assignments_driver_overlap exclude using gist (
    driver_id with =, tstzrange(starts_at, ends_at, '[)') with &&) where (status = 'active')
);
create unique index dispatch_assignments_one_active on public.dispatch_assignments (load_id) where status = 'active';
create index dispatch_assignments_order_idx on public.dispatch_assignments (order_id);
create index dispatch_assignments_day_idx on public.dispatch_assignments (company_id, starts_at);

-- Assignments are history: only cancellation and the load-time sync may change
-- an active row; canceled rows never change; rows are never deleted (except
-- with their order by the owner-only sample purge).
create or replace function private.guard_dispatch_assignment()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if current_setting('tlt.sample_purge', true) = 'on' then
      return old;
    end if;
    raise exception 'Dispatch assignments are history and cannot be deleted. Cancel them instead.' using errcode = '42501';
  end if;
  if old.status = 'canceled' then
    raise exception 'A canceled assignment cannot be changed.' using errcode = '42501';
  end if;
  if (new.load_id, new.order_id, new.truck_id, new.trailer_id, new.driver_id, new.created_by, new.created_at,
      new.replaces_assignment_id, new.warnings, new.note)
     is distinct from
     (old.load_id, old.order_id, old.truck_id, old.trailer_id, old.driver_id, old.created_by, old.created_at,
      old.replaces_assignment_id, old.warnings, old.note) then
    raise exception 'Assignments cannot be edited. Reassign the load instead.' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger dispatch_assignments_guard before update or delete on public.dispatch_assignments
  for each row execute function private.guard_dispatch_assignment();

create trigger a_company_guard before update of company_id on public.order_loads
  for each row execute function private.forbid_company_change();
create trigger a_company_guard before update of company_id on public.dispatch_assignments
  for each row execute function private.forbid_company_change();

alter table public.order_loads enable row level security;
alter table public.dispatch_assignments enable row level security;

-- Readable on the board (dispatch.view) and on the order page (orders.view).
create policy order_loads_read on public.order_loads for select to authenticated
  using (company_id = (select private.current_company_id())
         and ((select private.has_permission('dispatch.view')) or (select private.has_permission('orders.view'))));
create policy dispatch_assignments_read on public.dispatch_assignments for select to authenticated
  using (company_id = (select private.current_company_id())
         and ((select private.has_permission('dispatch.view')) or (select private.has_permission('orders.view'))));

revoke all on public.order_loads, public.dispatch_assignments from anon, authenticated;
grant select on public.order_loads, public.dispatch_assignments to authenticated;
grant all on public.order_loads, public.dispatch_assignments to service_role;

-- -----------------------------------------------------------------------------
-- 3. Eligibility shared with the fleet registry
-- -----------------------------------------------------------------------------
-- The rules of public.check_assignment_eligibility, for a company already
-- resolved by the caller. The public function now delegates to this one.
create or replace function private.assignment_eligibility(
  p_company uuid,
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
  v_company := p_company;
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
  v_company uuid;
begin
  perform private.require_permission('fleet.view');
  v_company := private.require_company();
  return private.assignment_eligibility(v_company, p_truck_id, p_trailer_id, p_driver_id, p_on);
end;
$$;

-- Text for eligibility codes (mirrors ELIGIBILITY_MESSAGES in src/lib/fleet/eligibility.ts; parity-tested).
create or replace function private.eligibility_message(p_code text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_code
    when 'truck_inactive' then 'Truck is deactivated.'
    when 'truck_out_of_service' then 'Truck is out of service.'
    when 'truck_capacity_unknown' then 'Truck capacity is not recorded.'
    when 'truck_capacity_unverified' then 'Truck capacity is recorded but not verified.'
    when 'trailer_inactive' then 'Trailer is deactivated.'
    when 'trailer_out_of_service' then 'Trailer is out of service.'
    when 'trailer_capacity_unknown' then 'Trailer capacity is not recorded.'
    when 'trailer_capacity_unverified' then 'Trailer capacity is recorded but not verified.'
    when 'trailer_incompatible' then 'This trailer is not recorded as compatible with this truck type.'
    when 'trailer_compatibility_unknown' then 'Trailer compatibility is not recorded.'
    when 'trailer_required' then 'A tractor needs a trailer for this load.'
    when 'driver_inactive' then 'Driver is inactive.'
    when 'cdl_missing' then 'No CDL is recorded for this driver.'
    when 'cdl_class_insufficient' then 'Driver''s CDL class is not high enough for this combination.'
    when 'cdl_expired' then 'Driver''s CDL has expired.'
    when 'cdl_expiry_unknown' then 'Driver''s CDL expiry date is not recorded.'
    when 'cdl_unverified' then 'Driver''s CDL has not been verified.'
    when 'cdl_expiring_soon' then 'Driver''s CDL expires within 30 days.'
    when 'medical_card_missing' then 'No DOT medical card is recorded for this driver.'
    when 'medical_card_class_insufficient' then 'Medical card does not qualify.'
    when 'medical_card_expired' then 'Driver''s medical card has expired.'
    when 'medical_card_expiry_unknown' then 'Driver''s medical card expiry date is not recorded.'
    when 'medical_card_unverified' then 'Driver''s medical card has not been verified.'
    when 'medical_card_expiring_soon' then 'Driver''s medical card expires within 30 days.'
    else p_code
  end
$$;

-- -----------------------------------------------------------------------------
-- 4. Helpers
-- -----------------------------------------------------------------------------
-- Orders whose work can be planned and assigned.
create or replace function private.order_is_dispatchable(p_status public.order_status)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_status in ('scheduled', 'dispatched', 'in_progress', 'partially_completed')
$$;

-- "7:00 AM" in the company's timezone.
create or replace function private.local_time_label(p_company uuid, p_at timestamptz)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select ltrim(to_char(p_at at time zone private.business_timezone(p_company), 'HH12:MI AM'), '0')
$$;

-- First active assignment (other than p_except) that overlaps the interval for
-- the given resource, described for an error message; null when free.
create or replace function private.resource_conflict(
  p_company uuid,
  p_kind text,
  p_resource_id uuid,
  p_starts timestamptz,
  p_ends timestamptz,
  p_except uuid
)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select format('%s is already assigned to %s load %s from %s to %s.',
                case p_kind when 'truck' then 'Truck ' || t.unit_number
                            when 'trailer' then 'Trailer ' || r.unit_number
                            else coalesce(nullif(trim(p.full_name), ''), nullif(d.name, ''), 'The driver') end,
                o.order_number, l.load_number,
                private.local_time_label(p_company, a.starts_at), private.local_time_label(p_company, a.ends_at))
  from public.dispatch_assignments a
  join public.order_loads l on l.id = a.load_id
  join public.orders o on o.id = a.order_id
  join public.trucks t on t.id = a.truck_id
  left join public.trailers r on r.id = a.trailer_id
  join public.drivers d on d.id = a.driver_id
  left join public.profiles p on p.id = d.user_id
  where a.company_id = p_company
    and a.status = 'active'
    and a.id is distinct from p_except
    and tstzrange(a.starts_at, a.ends_at, '[)') && tstzrange(p_starts, p_ends, '[)')
    and case p_kind when 'truck' then a.truck_id when 'trailer' then a.trailer_id else a.driver_id end = p_resource_id
  order by a.starts_at
  limit 1
$$;

-- Full check for putting truck/trailer/driver on an interval of a load date.
-- Raises a clear error for ineligible resources and for conflicts; returns the
-- eligibility warnings.
create or replace function private.check_assignment(
  p_company uuid,
  p_truck_id uuid,
  p_trailer_id uuid,
  p_driver_id uuid,
  p_on date,
  p_starts timestamptz,
  p_ends timestamptz,
  p_except uuid
)
returns text[]
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_result   jsonb;
  v_blockers text[];
  v_type     public.truck_type;
  v_conflict text;
begin
  if p_truck_id is null or p_driver_id is null then
    raise exception 'Choose a truck and a driver.';
  end if;
  -- Raises "Truck/Trailer/Driver not found." for ids outside the company.
  v_result := private.assignment_eligibility(p_company, p_truck_id, p_trailer_id, p_driver_id, p_on);
  select array(select jsonb_array_elements_text(v_result -> 'blockers')) into v_blockers;
  select truck_type into v_type from public.trucks where id = p_truck_id and company_id = p_company;
  if v_type = 'tractor' and p_trailer_id is null then
    v_blockers := v_blockers || 'trailer_required'::text;
  end if;
  if cardinality(v_blockers) > 0 then
    raise exception 'Not eligible on %: %', to_char(p_on, 'Mon FMDD, YYYY'),
      (select string_agg(private.eligibility_message(b), ' ') from unnest(v_blockers) b);
  end if;

  v_conflict := coalesce(
    private.resource_conflict(p_company, 'truck', p_truck_id, p_starts, p_ends, p_except),
    case when p_trailer_id is not null then private.resource_conflict(p_company, 'trailer', p_trailer_id, p_starts, p_ends, p_except) end,
    private.resource_conflict(p_company, 'driver', p_driver_id, p_starts, p_ends, p_except));
  if v_conflict is not null then
    raise exception '%', v_conflict;
  end if;

  return array(select jsonb_array_elements_text(v_result -> 'warnings'));
end;
$$;

-- Text for an assignment in audit summaries.
create or replace function private.assignment_label(p_truck_id uuid, p_trailer_id uuid, p_driver_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select concat_ws(', ',
    'truck ' || (select unit_number from public.trucks where id = p_truck_id),
    'trailer ' || (select unit_number from public.trailers where id = p_trailer_id),
    'driver ' || (select coalesce(nullif(trim(p.full_name), ''), nullif(d.name, ''), 'unnamed')
                  from public.drivers d left join public.profiles p on p.id = d.user_id where d.id = p_driver_id))
$$;

-- -----------------------------------------------------------------------------
-- 5. Loads
-- -----------------------------------------------------------------------------
-- Payload: load_id (null = new), order_id, load_date, start_time, end_time,
-- planned_quantity, unit_code, notes.
create or replace function public.save_order_load(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company  uuid;
  v_load     public.order_loads%rowtype;
  v_order    public.orders%rowtype;
  v_is_new   boolean := nullif(p_payload ->> 'load_id', '') is null;
  v_date     date;
  v_start    time;
  v_end      time;
  v_starts   timestamptz;
  v_ends     timestamptz;
  v_qty      numeric;
  v_unit     text := nullif(p_payload ->> 'unit_code', '');
  v_tz       text;
  v_active   public.dispatch_assignments%rowtype;
  v_number   integer;
begin
  perform private.require_permission('dispatch.edit');
  v_company := private.require_company();
  v_tz := private.business_timezone(v_company);

  if v_is_new then
    select * into v_order from public.orders
    where id = nullif(p_payload ->> 'order_id', '')::uuid and company_id = v_company for update;
    if not found then raise exception 'Order not found.'; end if;
  else
    select * into v_load from public.order_loads
    where id = (p_payload ->> 'load_id')::uuid and company_id = v_company for update;
    if not found then raise exception 'Load not found.'; end if;
    if v_load.status = 'canceled' then raise exception 'Load % is canceled and cannot be changed.', v_load.load_number; end if;
    select * into v_order from public.orders where id = v_load.order_id for update;
  end if;

  if not private.order_is_dispatchable(v_order.status) then
    raise exception 'Order % is %. Mark it scheduled before planning loads.',
      v_order.order_number, replace(v_order.status::text, '_', ' ');
  end if;

  v_date := nullif(p_payload ->> 'load_date', '')::date;
  v_start := nullif(p_payload ->> 'start_time', '')::time;
  v_end := nullif(p_payload ->> 'end_time', '')::time;
  if v_date is null or v_start is null or v_end is null then
    raise exception 'Enter the date, start time and end time of the load.';
  end if;
  if v_end <= v_start then
    raise exception 'The load must end after it starts (same day).';
  end if;
  if v_order.scheduled_start is null
     or v_date < v_order.scheduled_start
     or v_date > coalesce(v_order.scheduled_end, v_order.scheduled_start) then
    raise exception 'The load date must be within the order''s scheduled dates (%).',
      case when v_order.scheduled_start is null then 'not scheduled'
           else to_char(v_order.scheduled_start, 'Mon FMDD')
                || coalesce(' – ' || to_char(v_order.scheduled_end, 'Mon FMDD'), '') end;
  end if;

  v_qty := nullif(p_payload ->> 'planned_quantity', '')::numeric;
  if (v_qty is null) <> (v_unit is null) then
    raise exception 'Enter both the planned quantity and its unit, or neither.';
  end if;
  if v_qty is not null and (v_qty <= 0 or v_qty > 999999.999 or v_qty <> round(v_qty, 3)) then
    raise exception 'Planned quantity must be greater than 0 with at most 3 decimal places.';
  end if;
  if v_unit is not null and not exists (select 1 from public.units_of_measure where company_id = v_company and code = v_unit) then
    raise exception 'Choose a valid unit.';
  end if;

  v_starts := (v_date + v_start) at time zone v_tz;
  v_ends := (v_date + v_end) at time zone v_tz;

  if v_is_new then
    select coalesce(max(load_number), 0) + 1 into v_number from public.order_loads where order_id = v_order.id;
    insert into public.order_loads (company_id, order_id, load_number, load_date, start_time, end_time, starts_at, ends_at,
                                    planned_quantity, unit_code, notes, created_by, updated_by)
    values (v_company, v_order.id, v_number, v_date, v_start, v_end, v_starts, v_ends, v_qty, v_unit,
            private.clean_text(p_payload ->> 'notes', 1000, 'Notes'), auth.uid(), auth.uid())
    returning * into v_load;
    perform private.log_event('dispatch.load_planned', 'order', v_order.id,
      format('%s load %s planned for %s, %s–%s', v_order.order_number, v_load.load_number, to_char(v_date, 'Mon FMDD'),
             private.local_time_label(v_company, v_starts), private.local_time_label(v_company, v_ends)),
      jsonb_build_object('load_id', v_load.id, 'load_number', v_load.load_number));
  else
    -- A load that is already assigned keeps its assignment only if the truck,
    -- trailer and driver are still eligible and free at the new time.
    select * into v_active from public.dispatch_assignments where load_id = v_load.id and status = 'active' for update;
    if found and (v_starts, v_ends) is distinct from (v_load.starts_at, v_load.ends_at) then
      perform private.check_assignment(v_company, v_active.truck_id, v_active.trailer_id, v_active.driver_id,
                                       v_date, v_starts, v_ends, v_active.id);
      begin
        update public.dispatch_assignments set starts_at = v_starts, ends_at = v_ends where id = v_active.id;
      exception when exclusion_violation then
        raise exception 'The new time overlaps another assignment that was just made. Reload the board.';
      end;
    end if;
    update public.order_loads set
      load_date = v_date, start_time = v_start, end_time = v_end, starts_at = v_starts, ends_at = v_ends,
      planned_quantity = v_qty, unit_code = v_unit,
      notes = private.clean_text(p_payload ->> 'notes', 1000, 'Notes'),
      updated_by = auth.uid(), updated_at = now()
    where id = v_load.id
    returning * into v_load;
    perform private.log_event('dispatch.load_updated', 'order', v_order.id,
      format('%s load %s changed: %s, %s–%s', v_order.order_number, v_load.load_number, to_char(v_date, 'Mon FMDD'),
             private.local_time_label(v_company, v_starts), private.local_time_label(v_company, v_ends)),
      jsonb_build_object('load_id', v_load.id, 'load_number', v_load.load_number));
  end if;

  return jsonb_build_object('load_id', v_load.id, 'load_number', v_load.load_number);
end;
$$;

create or replace function public.cancel_order_load(p_load_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid;
  v_load    public.order_loads%rowtype;
  v_reason  text := private.clean_text(p_reason, 500, 'Reason');
  v_order   text;
begin
  perform private.require_permission('dispatch.edit');
  v_company := private.require_company();
  select * into v_load from public.order_loads where id = p_load_id and company_id = v_company for update;
  if not found then raise exception 'Load not found.'; end if;
  if v_load.status = 'canceled' then raise exception 'Load % is already canceled.', v_load.load_number; end if;
  if length(v_reason) = 0 then raise exception 'Enter a reason for canceling the load.'; end if;

  update public.dispatch_assignments set status = 'canceled', canceled_at = now(), canceled_by = auth.uid(),
    cancel_reason = 'Load canceled: ' || v_reason
  where load_id = v_load.id and status = 'active';
  update public.order_loads set status = 'canceled', canceled_at = now(), canceled_by = auth.uid(),
    cancel_reason = v_reason, updated_by = auth.uid(), updated_at = now()
  where id = v_load.id;

  select order_number into v_order from public.orders where id = v_load.order_id;
  perform private.log_event('dispatch.load_canceled', 'order', v_load.order_id,
    format('%s load %s canceled: %s', v_order, v_load.load_number, v_reason),
    jsonb_build_object('load_id', v_load.id, 'load_number', v_load.load_number, 'reason', v_reason));
  return jsonb_build_object('load_id', v_load.id, 'status', 'canceled');
end;
$$;

-- -----------------------------------------------------------------------------
-- 6. Assignments
-- -----------------------------------------------------------------------------
-- Assign a truck (+ trailer) and driver to a load, or reassign it.
-- p_replace_assignment_id must name the load's current active assignment (or be
-- null when it has none): a stale board cannot silently overwrite someone
-- else's assignment.
create or replace function public.assign_load(
  p_load_id uuid,
  p_truck_id uuid,
  p_trailer_id uuid,
  p_driver_id uuid,
  p_note text default '',
  p_replace_assignment_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company    uuid;
  v_load       public.order_loads%rowtype;
  v_order      public.orders%rowtype;
  v_current    public.dispatch_assignments%rowtype;
  v_has_current boolean;
  v_warnings   text[];
  v_new        public.dispatch_assignments%rowtype;
  v_constraint text;
  v_note       text := private.clean_text(p_note, 500, 'Note');
begin
  perform private.require_permission('dispatch.edit');
  v_company := private.require_company();

  select * into v_load from public.order_loads where id = p_load_id and company_id = v_company for update;
  if not found then raise exception 'Load not found.'; end if;
  select * into v_order from public.orders where id = v_load.order_id;
  if v_load.status = 'canceled' then
    raise exception '% load % is canceled.', v_order.order_number, v_load.load_number;
  end if;
  if not private.order_is_dispatchable(v_order.status) then
    raise exception 'Order % is %. Mark it scheduled before assigning trucks.',
      v_order.order_number, replace(v_order.status::text, '_', ' ');
  end if;

  select * into v_current from public.dispatch_assignments where load_id = v_load.id and status = 'active' for update;
  v_has_current := found;
  if v_has_current is distinct from (p_replace_assignment_id is not null)
     or (v_has_current and v_current.id <> p_replace_assignment_id) then
    raise exception 'The assignment of % load % was changed by someone else. Reload the board.',
      v_order.order_number, v_load.load_number using errcode = 'PT409';
  end if;
  if v_has_current and (v_current.truck_id, v_current.trailer_id, v_current.driver_id)
                       is not distinct from (p_truck_id, p_trailer_id, p_driver_id) then
    raise exception 'This load is already assigned to that truck, trailer and driver.';
  end if;

  v_warnings := private.check_assignment(v_company, p_truck_id, p_trailer_id, p_driver_id,
                                          v_load.load_date, v_load.starts_at, v_load.ends_at,
                                          case when v_has_current then v_current.id end);

  if v_has_current then
    update public.dispatch_assignments set status = 'canceled', canceled_at = now(), canceled_by = auth.uid(),
      cancel_reason = 'Reassigned' || coalesce(': ' || nullif(v_note, ''), '')
    where id = v_current.id;
  end if;

  begin
    insert into public.dispatch_assignments (company_id, load_id, order_id, truck_id, trailer_id, driver_id,
                                             starts_at, ends_at, note, warnings, replaces_assignment_id, created_by)
    values (v_company, v_load.id, v_order.id, p_truck_id, p_trailer_id, p_driver_id,
            v_load.starts_at, v_load.ends_at, v_note, v_warnings,
            case when v_has_current then v_current.id end, auth.uid())
    returning * into v_new;
  exception when exclusion_violation then
    -- Another request booked the same resource at the same moment.
    get stacked diagnostics v_constraint = constraint_name;
    raise exception '% was just assigned to another load at this time by someone else. Reload the board.',
      case when v_constraint like '%truck%' then 'The truck'
           when v_constraint like '%trailer%' then 'The trailer'
           else 'The driver' end
      using errcode = 'PT409';
  end;

  perform private.log_event(case when v_has_current then 'dispatch.reassigned' else 'dispatch.assigned' end,
    'order', v_order.id,
    format('%s load %s %s: %s', v_order.order_number, v_load.load_number,
           case when v_has_current then 'reassigned' else 'assigned' end,
           private.assignment_label(p_truck_id, p_trailer_id, p_driver_id)),
    jsonb_build_object('load_id', v_load.id, 'assignment_id', v_new.id,
                       'replaces_assignment_id', case when v_has_current then v_current.id end,
                       'previous', case when v_has_current then private.assignment_label(v_current.truck_id, v_current.trailer_id, v_current.driver_id) end,
                       'warnings', to_jsonb(v_warnings)));

  return jsonb_build_object('assignment_id', v_new.id, 'warnings', to_jsonb(v_warnings));
end;
$$;

create or replace function public.cancel_assignment(p_assignment_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid;
  v_a       public.dispatch_assignments%rowtype;
  v_reason  text := private.clean_text(p_reason, 500, 'Reason');
  v_order   text;
  v_load_no integer;
begin
  perform private.require_permission('dispatch.edit');
  v_company := private.require_company();
  select * into v_a from public.dispatch_assignments where id = p_assignment_id and company_id = v_company for update;
  if not found then raise exception 'Assignment not found.'; end if;
  if v_a.status = 'canceled' then raise exception 'This assignment is already canceled.'; end if;
  if length(v_reason) = 0 then raise exception 'Enter a reason for removing the assignment.'; end if;

  update public.dispatch_assignments set status = 'canceled', canceled_at = now(), canceled_by = auth.uid(),
    cancel_reason = v_reason
  where id = v_a.id;

  select o.order_number, l.load_number into v_order, v_load_no
  from public.orders o join public.order_loads l on l.id = v_a.load_id where o.id = v_a.order_id;
  perform private.log_event('dispatch.unassigned', 'order', v_a.order_id,
    format('%s load %s unassigned (%s): %s', v_order, v_load_no,
           private.assignment_label(v_a.truck_id, v_a.trailer_id, v_a.driver_id), v_reason),
    jsonb_build_object('assignment_id', v_a.id, 'load_id', v_a.load_id, 'reason', v_reason));
  return jsonb_build_object('assignment_id', v_a.id, 'status', 'canceled');
end;
$$;

-- -----------------------------------------------------------------------------
-- 7. Order status changes release resources
-- -----------------------------------------------------------------------------
-- Canceling an order, putting it on hold or moving it back to Confirmed cancels
-- its active assignments that have not ended yet (and, for a canceled order,
-- its planned loads). History is kept.
create or replace function private.release_order_assignments()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reason text;
  v_count  integer;
begin
  if new.status = old.status or new.status not in ('canceled', 'on_hold', 'confirmed') then
    return new;
  end if;
  v_reason := case new.status when 'canceled' then 'Order canceled'
                              when 'on_hold' then 'Order put on hold'
                              else 'Order moved back to Confirmed' end;
  update public.dispatch_assignments set status = 'canceled', canceled_at = now(), canceled_by = auth.uid(),
    cancel_reason = v_reason
  where order_id = new.id and status = 'active' and ends_at > now();
  get diagnostics v_count = row_count;
  if new.status = 'canceled' then
    update public.order_loads set status = 'canceled', canceled_at = now(), canceled_by = auth.uid(),
      cancel_reason = v_reason, updated_at = now()
    where order_id = new.id and status = 'planned';
  end if;
  if v_count > 0 then
    perform private.log_event('dispatch.released', 'order', new.id,
      format('%s: %s assignment(s) released (%s)', new.order_number, v_count, lower(v_reason)),
      jsonb_build_object('count', v_count, 'reason', v_reason));
  end if;
  return new;
end;
$$;

create trigger orders_release_assignments after update of status on public.orders
  for each row execute function private.release_order_assignments();

-- -----------------------------------------------------------------------------
-- 8. Grants
-- -----------------------------------------------------------------------------
revoke execute on function
  public.save_order_load(jsonb),
  public.cancel_order_load(uuid, text),
  public.assign_load(uuid, uuid, uuid, uuid, text, uuid),
  public.cancel_assignment(uuid, text)
from public, anon;
grant execute on function
  public.save_order_load(jsonb),
  public.cancel_order_load(uuid, text),
  public.assign_load(uuid, uuid, uuid, uuid, text, uuid),
  public.cancel_assignment(uuid, text)
to authenticated;

revoke execute on function
  private.guard_dispatch_assignment(),
  private.assignment_eligibility(uuid, uuid, uuid, uuid, date),
  private.eligibility_message(text),
  private.order_is_dispatchable(public.order_status),
  private.local_time_label(uuid, timestamptz),
  private.resource_conflict(uuid, text, uuid, timestamptz, timestamptz, uuid),
  private.check_assignment(uuid, uuid, uuid, uuid, date, timestamptz, timestamptz, uuid),
  private.assignment_label(uuid, uuid, uuid),
  private.release_order_assignments()
from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 9. Verification
-- -----------------------------------------------------------------------------
do $$
begin
  if (select count(*) from public.role_permissions where permission = 'dispatch.edit')
     <> 3 * (select count(*) from public.companies) then
    raise exception 'dispatch.edit was not granted to owner, office and dispatcher in every company';
  end if;
end;
$$;
