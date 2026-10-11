-- =============================================================================
-- Mechanics & Maintenance: work orders, preventive maintenance, readings,
-- repair costs and the return-to-service (clearance) queue.
--
-- * public.work_orders — one repair, inspection or service job on a truck,
--   optionally linked to a driver and to the driver's field report. Changed
--   only through the functions below, which enforce the lifecycle:
--     reported → triaged → scheduled → in_progress ⇄ awaiting_parts
--       → awaiting_inspection → completed → closed      (and canceled)
-- * public.work_order_events — append-only history (status, schedule,
--   assignment, inspection and clearance, with who and when).
-- * public.work_order_costs — parts, labor, vendor and other cost lines. Read
--   and written only with 'maintenance.costs' (separate table so no other
--   permission can see amounts).
-- * public.maintenance_schedules — preventive maintenance per truck: calendar
--   days, miles and/or engine hours (whichever comes first), with warning
--   windows. public.maintenance_pm_status() computes next due and the state
--   (overdue / due_soon / ok / unknown); missing or stale readings stay visible.
-- * public.truck_readings — odometer and engine-hour readings. A reading lower
--   than the latest one is refused.
--
-- Safety: a work order marked safety-critical takes the truck out of service
-- (dispatch already refuses out-of-service trucks). It cannot be completed
-- directly: it goes to awaiting_inspection, and only someone with
-- 'maintenance.clear' can record the inspection. A trigger refuses to return
-- the truck to service, by any path, while such a work order is open.
--
-- Permissions (per role, editable by owners like every other permission):
--   maintenance.view    see work orders, schedules, readings and the queue
--   maintenance.manage  create, edit, assign and move work orders; schedules; readings
--   maintenance.costs   see and record parts, labor, vendor and cost lines
--   maintenance.clear   inspect and clear vehicles for service; cancel or
--                       downgrade safety-critical work orders
--
-- Additive: no existing row is changed except new document sequence rows and
-- new role permissions. Rollback: supabase/rollbacks/20261101000100_maintenance.down.sql
-- =============================================================================

insert into public.permissions (code, category, description) values
  ('maintenance.view',   'Maintenance', 'View work orders, preventive maintenance and the clearance queue'),
  ('maintenance.manage', 'Maintenance', 'Create, edit, assign and update work orders, schedules and readings'),
  ('maintenance.costs',  'Maintenance', 'View and record parts, labor, vendor and repair costs'),
  ('maintenance.clear',  'Maintenance', 'Inspect and clear vehicles to return to service after safety repairs');

insert into public.role_permission_defaults (role, permission) values
  ('owner', 'maintenance.view'), ('owner', 'maintenance.manage'), ('owner', 'maintenance.costs'), ('owner', 'maintenance.clear'),
  ('mechanic', 'maintenance.view'), ('mechanic', 'maintenance.manage'),
  ('office', 'maintenance.view'), ('office', 'maintenance.costs'),
  ('dispatcher', 'maintenance.view');

insert into public.role_permissions (company_id, role, permission)
select c.id, d.role, d.permission
from public.companies c
cross join public.role_permission_defaults d
where d.permission like 'maintenance.%'
on conflict do nothing;

-- Work order numbers (WO-2026-0001), per company like the other documents.
alter table public.document_sequences drop constraint document_sequences_key_check;
alter table public.document_sequences add constraint document_sequences_key_check
  check (key in ('customer', 'quote', 'order', 'ticket', 'billing', 'work_order'));
insert into public.document_sequences (company_id, key, label, prefix, include_year, pad)
select id, 'work_order', 'Work order numbers', 'WO-', true, 4 from public.companies
on conflict do nothing;

create or replace function private.add_work_order_sequence()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.document_sequences (company_id, key, label, prefix, include_year, pad)
  values (new.id, 'work_order', 'Work order numbers', 'WO-', true, 4)
  on conflict do nothing;
  return new;
end;
$$;
create trigger companies_work_order_sequence after insert on public.companies
  for each row execute function private.add_work_order_sequence();

-- -----------------------------------------------------------------------------
-- Tables
-- -----------------------------------------------------------------------------
create table public.truck_readings (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies (id),
  truck_id        uuid not null,
  odometer_miles  numeric(10, 1) check (odometer_miles between 0 and 9999999),
  engine_hours    numeric(9, 1) check (engine_hours between 0 and 999999),
  read_at         timestamptz not null default clock_timestamp(),
  note            text not null default '' check (length(note) <= 300),
  recorded_by     uuid references auth.users (id) on delete set null,
  foreign key (company_id, truck_id) references public.trucks (company_id, id),
  constraint truck_readings_value check (odometer_miles is not null or engine_hours is not null)
);
create index truck_readings_latest_idx on public.truck_readings (company_id, truck_id, read_at desc);

create table public.maintenance_schedules (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references public.companies (id),
  truck_id         uuid not null,
  name             text not null check (length(trim(name)) between 1 and 80),
  interval_days    integer check (interval_days between 1 and 3650),
  interval_miles   numeric(9, 1) check (interval_miles between 1 and 1000000),
  interval_hours   numeric(8, 1) check (interval_hours between 1 and 100000),
  warn_days        integer not null default 14 check (warn_days between 0 and 365),
  warn_miles       numeric(9, 1) not null default 500 check (warn_miles between 0 and 100000),
  warn_hours       numeric(8, 1) not null default 25 check (warn_hours between 0 and 10000),
  last_done_on     date,
  last_done_miles  numeric(10, 1) check (last_done_miles >= 0),
  last_done_hours  numeric(9, 1) check (last_done_hours >= 0),
  active           boolean not null default true,
  notes            text not null default '' check (length(notes) <= 1000),
  created_by       uuid default auth.uid() references auth.users (id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (company_id, id),
  foreign key (company_id, truck_id) references public.trucks (company_id, id),
  constraint maintenance_schedules_trigger check (
    interval_days is not null or interval_miles is not null or interval_hours is not null)
);
create unique index maintenance_schedules_name_key on public.maintenance_schedules (company_id, truck_id, lower(name)) where active;

create table public.work_orders (
  id                      uuid primary key default gen_random_uuid(),
  company_id              uuid not null references public.companies (id),
  number                  text not null,
  truck_id                uuid not null,
  driver_id               uuid,
  field_report_id         uuid,
  schedule_id             uuid,
  title                   text not null check (length(trim(title)) between 3 and 120),
  description             text not null default '' check (length(description) <= 4000),
  category                text not null default 'repair' check (category in (
    'preventive', 'repair', 'inspection', 'brakes', 'tires', 'engine', 'electrical', 'hydraulics', 'body', 'other')),
  urgency                 text not null default 'normal' check (urgency in ('low', 'normal', 'high', 'immediate')),
  safety_critical         boolean not null default false,
  status                  text not null default 'reported' check (status in (
    'reported', 'triaged', 'scheduled', 'in_progress', 'awaiting_parts', 'awaiting_inspection',
    'completed', 'closed', 'canceled')),
  assigned_to             uuid,
  scheduled_for           date,
  due_on                  date,
  findings                text not null default '' check (length(findings) <= 4000),
  labor_hours             numeric(7, 2) check (labor_hours between 0 and 10000),
  odometer_at_service     numeric(10, 1) check (odometer_at_service >= 0),
  engine_hours_at_service numeric(9, 1) check (engine_hours_at_service >= 0),
  -- True when this work order took the truck out of service (so clearing it may return the truck).
  restricted_truck        boolean not null default false,
  clearance_status        text check (clearance_status in ('awaiting', 'in_progress', 'failed', 'cleared')),
  inspector_id            uuid references auth.users (id) on delete set null,
  cleared_by              uuid references auth.users (id) on delete set null,
  cleared_at              timestamptz,
  clearance_notes         text not null default '' check (length(clearance_notes) <= 2000),
  completed_at            timestamptz,
  closed_at               timestamptz,
  cancel_reason           text not null default '' check (length(cancel_reason) <= 500),
  source                  text not null default 'manual' check (source in ('manual', 'field_report', 'preventive')),
  submission_key          uuid,
  edit_seq                integer not null default 1,
  created_by              uuid default auth.uid() references auth.users (id) on delete set null,
  created_at              timestamptz not null default now(),
  updated_by              uuid references auth.users (id) on delete set null,
  updated_at              timestamptz not null default now(),
  unique (company_id, id),
  unique (company_id, number),
  foreign key (company_id, truck_id) references public.trucks (company_id, id),
  foreign key (company_id, driver_id) references public.drivers (company_id, id),
  foreign key (company_id, field_report_id) references public.field_reports (company_id, id),
  foreign key (company_id, schedule_id) references public.maintenance_schedules (company_id, id),
  constraint work_orders_assignee_fk foreign key (company_id, assigned_to)
    references public.company_memberships (company_id, user_id) on delete set null (assigned_to),
  constraint work_orders_scheduled check (status <> 'scheduled' or scheduled_for is not null),
  constraint work_orders_safety_completion check (
    not safety_critical or status not in ('completed', 'closed') or clearance_status = 'cleared')
);
create unique index work_orders_submission_key on public.work_orders (company_id, submission_key) where submission_key is not null;
-- At most one open work order per preventive schedule: processing a due trigger twice creates nothing new.
create unique index work_orders_open_schedule_key on public.work_orders (schedule_id)
  where schedule_id is not null and status not in ('completed', 'closed', 'canceled');
create index work_orders_open_idx on public.work_orders (company_id, status, truck_id);

create table public.work_order_events (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.companies (id),
  work_order_id  uuid not null,
  kind           text not null check (kind in (
    'created', 'updated', 'status', 'assigned', 'scheduled', 'rescheduled', 'unscheduled', 'canceled',
    'inspection_started', 'inspection_failed', 'cleared', 'restricted', 'returned_to_service')),
  from_status    text,
  to_status      text,
  note           text not null default '' check (length(note) <= 2000),
  details        jsonb not null default '{}'::jsonb,
  actor_id       uuid references auth.users (id) on delete set null,
  created_at     timestamptz not null default now(),
  foreign key (company_id, work_order_id) references public.work_orders (company_id, id) on delete cascade
);
create index work_order_events_wo_idx on public.work_order_events (company_id, work_order_id, created_at);

create table public.work_order_costs (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null default private.current_company_id() references public.companies (id),
  work_order_id    uuid not null,
  kind             text not null check (kind in ('part', 'labor', 'vendor', 'other')),
  description      text not null check (length(trim(description)) between 1 and 200),
  part_number      text not null default '' check (length(part_number) <= 60),
  vendor_name      text not null default '' check (length(vendor_name) <= 120),
  quantity         numeric(10, 2) not null default 1 check (quantity > 0 and quantity <= 100000),
  unit_cost_cents  bigint not null check (unit_cost_cents between 0 and 100000000000),
  created_by       uuid default auth.uid() references auth.users (id) on delete set null,
  created_at       timestamptz not null default now(),
  foreign key (company_id, work_order_id) references public.work_orders (company_id, id) on delete cascade
);
create index work_order_costs_wo_idx on public.work_order_costs (company_id, work_order_id);

-- Row guards and audit
create trigger a_company_guard before update of company_id on public.truck_readings
  for each row execute function private.forbid_company_change();
create trigger a_company_guard before update of company_id on public.maintenance_schedules
  for each row execute function private.forbid_company_change();
create trigger a_company_guard before update of company_id on public.work_orders
  for each row execute function private.forbid_company_change();
create trigger a_company_guard before update of company_id on public.work_order_events
  for each row execute function private.forbid_company_change();
create trigger a_company_guard before update of company_id on public.work_order_costs
  for each row execute function private.forbid_company_change();
create trigger work_orders_audit after insert or update or delete on public.work_orders
  for each row execute function private.audit_row_change('work_order');
create trigger maintenance_schedules_audit after insert or update or delete on public.maintenance_schedules
  for each row execute function private.audit_row_change('maintenance_schedule');
create trigger work_order_costs_audit after insert or update or delete on public.work_order_costs
  for each row execute function private.audit_row_change('work_order_cost');

-- Cost lines only while the work order is still open for changes.
create or replace function private.guard_work_order_cost()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_status text;
begin
  select status into v_status from public.work_orders
  where id = coalesce(new.work_order_id, old.work_order_id);
  if v_status in ('closed', 'canceled') then
    raise exception 'This work order is % — its costs can no longer be changed.', v_status using errcode = 'P0001';
  end if;
  return coalesce(new, old);
end;
$$;
create trigger work_order_costs_guard before insert or update or delete on public.work_order_costs
  for each row execute function private.guard_work_order_cost();

-- A truck with an open, uncleared safety-critical work order never returns to
-- service, whatever the path (fleet page, SQL, another function).
create or replace function private.guard_truck_clearance()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_number text;
begin
  if new.service_status = 'in_service' and old.service_status = 'out_of_service' then
    select w.number into v_number from public.work_orders w
    where w.company_id = new.company_id and w.truck_id = new.id and w.safety_critical
      and w.status not in ('completed', 'closed', 'canceled')
    limit 1;
    if v_number is not null then
      raise exception 'Truck % has an open safety-critical work order (%). It returns to service only after an authorized inspection clears it in Maintenance.', new.unit_number, v_number
        using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;
create trigger trucks_clearance_guard before update of service_status on public.trucks
  for each row execute function private.guard_truck_clearance();

-- -----------------------------------------------------------------------------
-- Row-level security: reads with maintenance.view; writes through functions,
-- except cost lines (maintenance.costs).
-- -----------------------------------------------------------------------------
alter table public.truck_readings enable row level security;
alter table public.maintenance_schedules enable row level security;
alter table public.work_orders enable row level security;
alter table public.work_order_events enable row level security;
alter table public.work_order_costs enable row level security;

create policy truck_readings_read on public.truck_readings for select to authenticated
  using (company_id = (select private.current_company_id()) and (select private.has_permission('maintenance.view')));
create policy maintenance_schedules_read on public.maintenance_schedules for select to authenticated
  using (company_id = (select private.current_company_id()) and (select private.has_permission('maintenance.view')));
create policy work_orders_read on public.work_orders for select to authenticated
  using (company_id = (select private.current_company_id()) and (select private.has_permission('maintenance.view')));
create policy work_order_events_read on public.work_order_events for select to authenticated
  using (company_id = (select private.current_company_id()) and (select private.has_permission('maintenance.view')));
create policy work_order_costs_read on public.work_order_costs for select to authenticated
  using (company_id = (select private.current_company_id()) and (select private.has_permission('maintenance.costs')));
create policy work_order_costs_insert on public.work_order_costs for insert to authenticated
  with check (company_id = (select private.current_company_id()) and (select private.has_permission('maintenance.costs')));
create policy work_order_costs_delete on public.work_order_costs for delete to authenticated
  using (company_id = (select private.current_company_id()) and (select private.has_permission('maintenance.costs')));

revoke all on public.truck_readings, public.maintenance_schedules, public.work_orders,
  public.work_order_events, public.work_order_costs from anon, authenticated;
grant select on public.truck_readings, public.maintenance_schedules, public.work_orders,
  public.work_order_events to authenticated;
grant select, delete on public.work_order_costs to authenticated;
grant insert (work_order_id, kind, description, part_number, vendor_name, quantity, unit_cost_cents)
  on public.work_order_costs to authenticated;
grant all on public.truck_readings, public.maintenance_schedules, public.work_orders,
  public.work_order_events, public.work_order_costs to service_role;

-- -----------------------------------------------------------------------------
-- Helpers (internal)
-- -----------------------------------------------------------------------------
create or replace function private.wo_event(
  p_company uuid, p_wo uuid, p_kind text, p_from text, p_to text, p_note text, p_details jsonb default '{}'::jsonb)
returns void
language sql
set search_path = ''
as $$
  insert into public.work_order_events (company_id, work_order_id, kind, from_status, to_status, note, details, actor_id)
  values (p_company, p_wo, p_kind, p_from, p_to, coalesce(p_note, ''), coalesce(p_details, '{}'::jsonb), auth.uid());
$$;

-- Lifecycle: which manual status changes are allowed. awaiting_inspection is
-- left only through the inspection (record_clearance); safety rules on top.
create or replace function private.wo_transition_ok(p_from text, p_to text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case p_from
    when 'reported'       then p_to in ('triaged', 'scheduled', 'in_progress', 'canceled')
    when 'triaged'        then p_to in ('scheduled', 'in_progress', 'canceled')
    when 'scheduled'      then p_to in ('triaged', 'in_progress', 'canceled')
    when 'in_progress'    then p_to in ('awaiting_parts', 'awaiting_inspection', 'completed', 'scheduled', 'canceled')
    when 'awaiting_parts' then p_to in ('in_progress', 'scheduled', 'canceled')
    when 'completed'      then p_to in ('closed', 'in_progress')
    else false
  end;
$$;

-- Take the work order's truck out of service for a safety-critical defect.
create or replace function private.wo_restrict_truck(p_wo uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_wo    public.work_orders%rowtype;
  v_truck public.trucks%rowtype;
begin
  select * into v_wo from public.work_orders where id = p_wo;
  select * into v_truck from public.trucks where id = v_wo.truck_id and company_id = v_wo.company_id for update;
  if v_truck.service_status = 'in_service' then
    update public.trucks set
      service_status = 'out_of_service',
      out_of_service_reason = left('Safety-critical defect — work order ' || v_wo.number || ': ' || v_wo.title, 500),
      out_of_service_since = now(),
      expected_return_date = null
    where id = v_truck.id;
    insert into public.equipment_status_events (company_id, truck_id, from_status, to_status, reason, actor_id)
    values (v_wo.company_id, v_truck.id, 'in_service', 'out_of_service',
            left('Safety-critical defect — work order ' || v_wo.number, 500), auth.uid());
    update public.work_orders set restricted_truck = true where id = p_wo;
    perform private.wo_event(v_wo.company_id, p_wo, 'restricted', null, null,
      'Truck ' || v_truck.unit_number || ' taken out of service until an authorized inspection clears it.');
  else
    perform private.wo_event(v_wo.company_id, p_wo, 'restricted', null, null,
      'Truck ' || v_truck.unit_number || ' was already out of service; it stays restricted until this work order is cleared.');
  end if;
end;
$$;

-- After clearance: return the truck if this work order restricted it and no
-- other open safety-critical work order remains.
create or replace function private.wo_release_truck(p_wo uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_wo    public.work_orders%rowtype;
  v_truck public.trucks%rowtype;
begin
  select * into v_wo from public.work_orders where id = p_wo;
  if not v_wo.restricted_truck then
    return false;
  end if;
  select * into v_truck from public.trucks where id = v_wo.truck_id and company_id = v_wo.company_id for update;
  if v_truck.service_status <> 'out_of_service' or exists (
    select 1 from public.work_orders w
    where w.company_id = v_wo.company_id and w.truck_id = v_wo.truck_id and w.id <> p_wo
      and w.safety_critical and w.status not in ('completed', 'closed', 'canceled')) then
    return false;
  end if;
  update public.trucks set service_status = 'in_service', out_of_service_reason = '', out_of_service_since = null,
    expected_return_date = null
  where id = v_truck.id;
  insert into public.equipment_status_events (company_id, truck_id, from_status, to_status, reason, actor_id)
  values (v_wo.company_id, v_truck.id, 'out_of_service', 'in_service',
          left('Cleared after inspection — work order ' || v_wo.number, 500), auth.uid());
  update public.work_orders set restricted_truck = false where id = p_wo;
  perform private.wo_event(v_wo.company_id, p_wo, 'returned_to_service', null, null,
    'Truck ' || v_truck.unit_number || ' returned to service.');
  return true;
end;
$$;

-- When preventive work is completed, the schedule restarts from that service.
create or replace function private.wo_complete_schedule(p_wo uuid)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_wo public.work_orders%rowtype;
begin
  select * into v_wo from public.work_orders where id = p_wo;
  if v_wo.schedule_id is null then
    return;
  end if;
  update public.maintenance_schedules s set
    last_done_on    = private.business_today(v_wo.company_id),
    last_done_miles = coalesce(v_wo.odometer_at_service,
      (select r.odometer_miles from public.truck_readings r where r.company_id = v_wo.company_id
         and r.truck_id = v_wo.truck_id and r.odometer_miles is not null order by r.read_at desc, r.odometer_miles desc limit 1),
      case when s.interval_miles is null then s.last_done_miles end),
    last_done_hours = coalesce(v_wo.engine_hours_at_service,
      (select r.engine_hours from public.truck_readings r where r.company_id = v_wo.company_id
         and r.truck_id = v_wo.truck_id and r.engine_hours is not null order by r.read_at desc, r.engine_hours desc limit 1),
      case when s.interval_hours is null then s.last_done_hours end),
    updated_at = now()
  where s.id = v_wo.schedule_id;
end;
$$;

create or replace function private.wo_validate_refs(
  p_company uuid, p_driver uuid, p_assignee uuid, p_field_report uuid)
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if p_driver is not null and not exists (select 1 from public.drivers where id = p_driver and company_id = p_company) then
    raise exception 'Driver not found.' using errcode = 'P0002';
  end if;
  if p_assignee is not null and not exists (
    select 1 from public.company_memberships where company_id = p_company and user_id = p_assignee and active) then
    raise exception 'The assigned person is not an active member of this company.' using errcode = 'P0002';
  end if;
  if p_field_report is not null and not exists (select 1 from public.field_reports where id = p_field_report and company_id = p_company) then
    raise exception 'Field report not found.' using errcode = 'P0002';
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- Preventive maintenance status (one source of truth for the page and for
-- generating due work orders). Whichever trigger comes first decides.
-- -----------------------------------------------------------------------------
create or replace function private.pm_due(p_company uuid)
returns table (
  schedule_id uuid, truck_id uuid, unit_number text, name text,
  interval_days integer, interval_miles numeric, interval_hours numeric,
  last_done_on date, last_done_miles numeric, last_done_hours numeric,
  next_due_on date, next_due_miles numeric, next_due_hours numeric,
  current_miles numeric, miles_read_at timestamptz, current_hours numeric, hours_read_at timestamptz,
  days_state text, miles_state text, hours_state text, state text,
  readings_stale boolean, open_work_order_id uuid, open_work_order_number text)
language sql
stable
set search_path = ''
as $$
  with base as (
    select s.*, t.unit_number, private.business_today(s.company_id) as today,
      m.odometer_miles as cur_miles, m.read_at as cur_miles_at,
      h.engine_hours as cur_hours, h.read_at as cur_hours_at
    from public.maintenance_schedules s
    join public.trucks t on t.company_id = s.company_id and t.id = s.truck_id and t.active
    left join lateral (select r.odometer_miles, r.read_at from public.truck_readings r
      where r.company_id = s.company_id and r.truck_id = s.truck_id and r.odometer_miles is not null
      order by r.read_at desc, r.odometer_miles desc limit 1) m on true
    left join lateral (select r.engine_hours, r.read_at from public.truck_readings r
      where r.company_id = s.company_id and r.truck_id = s.truck_id and r.engine_hours is not null
      order by r.read_at desc, r.engine_hours desc limit 1) h on true
    where s.company_id = p_company and s.active
  ), nxt as (
    select b.*,
      case when b.interval_days is not null and b.last_done_on is not null then b.last_done_on + b.interval_days end as n_on,
      case when b.interval_miles is not null and b.last_done_miles is not null then b.last_done_miles + b.interval_miles end as n_miles,
      case when b.interval_hours is not null and b.last_done_hours is not null then b.last_done_hours + b.interval_hours end as n_hours
    from base b
  ), st as (
    select n.*,
      case when n.interval_days is null then null
           when n.n_on is null then 'unknown'
           when n.today >= n.n_on then 'overdue'
           when n.today >= n.n_on - n.warn_days then 'due_soon'
           else 'ok' end as d_state,
      case when n.interval_miles is null then null
           when n.n_miles is null or n.cur_miles is null then 'unknown'
           when n.cur_miles >= n.n_miles then 'overdue'
           when n.cur_miles >= n.n_miles - n.warn_miles then 'due_soon'
           else 'ok' end as m_state,
      case when n.interval_hours is null then null
           when n.n_hours is null or n.cur_hours is null then 'unknown'
           when n.cur_hours >= n.n_hours then 'overdue'
           when n.cur_hours >= n.n_hours - n.warn_hours then 'due_soon'
           else 'ok' end as h_state
    from nxt n
  )
  select st.id, st.truck_id, st.unit_number, st.name,
    st.interval_days, st.interval_miles, st.interval_hours,
    st.last_done_on, st.last_done_miles, st.last_done_hours,
    st.n_on, st.n_miles, st.n_hours,
    st.cur_miles, st.cur_miles_at, st.cur_hours, st.cur_hours_at,
    st.d_state, st.m_state, st.h_state,
    case when 'overdue' in (st.d_state, st.m_state, st.h_state) then 'overdue'
         when 'due_soon' in (st.d_state, st.m_state, st.h_state) then 'due_soon'
         when 'ok' in (st.d_state, st.m_state, st.h_state) then 'ok'
         else 'unknown' end,
    coalesce(st.interval_miles is not null and st.cur_miles_at < now() - interval '30 days', false)
      or coalesce(st.interval_hours is not null and st.cur_hours_at < now() - interval '30 days', false),
    w.id, w.number
  from st
  left join public.work_orders w on w.schedule_id = st.id and w.status not in ('completed', 'closed', 'canceled');
$$;

/** Preventive maintenance status for the caller's current company (maintenance.view). */
create or replace function public.maintenance_pm_status()
returns table (
  schedule_id uuid, truck_id uuid, unit_number text, name text,
  interval_days integer, interval_miles numeric, interval_hours numeric,
  last_done_on date, last_done_miles numeric, last_done_hours numeric,
  next_due_on date, next_due_miles numeric, next_due_hours numeric,
  current_miles numeric, miles_read_at timestamptz, current_hours numeric, hours_read_at timestamptz,
  days_state text, miles_state text, hours_state text, state text,
  readings_stale boolean, open_work_order_id uuid, open_work_order_number text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_permission('maintenance.view');
  return query select * from private.pm_due(private.require_company());
end;
$$;

-- -----------------------------------------------------------------------------
-- Readings and schedules
-- -----------------------------------------------------------------------------
/** Record an odometer and/or engine-hour reading. A value lower than the latest is refused. */
create or replace function public.record_truck_reading(p_truck_id uuid, p_miles numeric, p_hours numeric, p_note text default '')
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v_last    numeric;
  v_id      uuid;
begin
  perform private.require_permission('maintenance.manage');
  if p_miles is null and p_hours is null then
    raise exception 'Enter the odometer, the engine hours, or both.';
  end if;
  perform 1 from public.trucks where id = p_truck_id and company_id = v_company for update;
  if not found then
    raise exception 'Truck not found.' using errcode = 'P0002';
  end if;
  if p_miles is not null then
    select odometer_miles into v_last from public.truck_readings
    where company_id = v_company and truck_id = p_truck_id and odometer_miles is not null order by read_at desc, odometer_miles desc limit 1;
    if v_last is not null and p_miles < v_last then
      raise exception 'The odometer cannot go down: the last reading was % miles.', v_last using errcode = '22023';
    end if;
  end if;
  if p_hours is not null then
    select engine_hours into v_last from public.truck_readings
    where company_id = v_company and truck_id = p_truck_id and engine_hours is not null order by read_at desc, engine_hours desc limit 1;
    if v_last is not null and p_hours < v_last then
      raise exception 'Engine hours cannot go down: the last reading was % hours.', v_last using errcode = '22023';
    end if;
  end if;
  insert into public.truck_readings (company_id, truck_id, odometer_miles, engine_hours, note, recorded_by)
  values (v_company, p_truck_id, p_miles, p_hours, private.clean_text(p_note, 300, 'Note'), auth.uid())
  returning id into v_id;
  return v_id;
end;
$$;

/**
 * Create or update a preventive schedule.
 * p: { id?, truck_id, name, interval_days?, interval_miles?, interval_hours?, warn_days?, warn_miles?,
 *      warn_hours?, last_done_on?, last_done_miles?, last_done_hours?, active?, notes? }
 */
create or replace function public.maintenance_save_schedule(p jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v_id      uuid := nullif(p ->> 'id', '')::uuid;
  v_truck   uuid := nullif(p ->> 'truck_id', '')::uuid;
  v_name    text := private.clean_text(p ->> 'name', 80, 'Name');
  v_last_on date := nullif(p ->> 'last_done_on', '')::date;
begin
  perform private.require_permission('maintenance.manage');
  if not exists (select 1 from public.trucks where id = v_truck and company_id = v_company) then
    raise exception 'Truck not found.' using errcode = 'P0002';
  end if;
  if length(v_name) = 0 then
    raise exception 'Enter a name for the service, for example "Oil and filter".';
  end if;
  if v_last_on is not null and v_last_on > private.business_today(v_company) then
    raise exception 'The last service date cannot be in the future.';
  end if;
  if v_id is null then
    insert into public.maintenance_schedules (company_id, truck_id, name, interval_days, interval_miles, interval_hours,
      warn_days, warn_miles, warn_hours, last_done_on, last_done_miles, last_done_hours, notes)
    values (v_company, v_truck, v_name,
      nullif(p ->> 'interval_days', '')::integer, nullif(p ->> 'interval_miles', '')::numeric,
      nullif(p ->> 'interval_hours', '')::numeric,
      coalesce(nullif(p ->> 'warn_days', '')::integer, 14), coalesce(nullif(p ->> 'warn_miles', '')::numeric, 500),
      coalesce(nullif(p ->> 'warn_hours', '')::numeric, 25),
      v_last_on, nullif(p ->> 'last_done_miles', '')::numeric, nullif(p ->> 'last_done_hours', '')::numeric,
      private.clean_text(p ->> 'notes', 1000, 'Notes'))
    returning id into v_id;
  else
    update public.maintenance_schedules set
      truck_id = v_truck, name = v_name,
      interval_days = nullif(p ->> 'interval_days', '')::integer,
      interval_miles = nullif(p ->> 'interval_miles', '')::numeric,
      interval_hours = nullif(p ->> 'interval_hours', '')::numeric,
      warn_days = coalesce(nullif(p ->> 'warn_days', '')::integer, 14),
      warn_miles = coalesce(nullif(p ->> 'warn_miles', '')::numeric, 500),
      warn_hours = coalesce(nullif(p ->> 'warn_hours', '')::numeric, 25),
      last_done_on = v_last_on,
      last_done_miles = nullif(p ->> 'last_done_miles', '')::numeric,
      last_done_hours = nullif(p ->> 'last_done_hours', '')::numeric,
      active = coalesce((p ->> 'active')::boolean, true),
      notes = private.clean_text(p ->> 'notes', 1000, 'Notes'),
      updated_at = now()
    where id = v_id and company_id = v_company;
    if not found then
      raise exception 'Schedule not found.' using errcode = 'P0002';
    end if;
  end if;
  return v_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- Work orders
-- -----------------------------------------------------------------------------
/**
 * Create a work order. p: { truck_id, title, description?, category?, urgency?, safety_critical?,
 * driver_id?, field_report_id?, assigned_to?, scheduled_for?, due_on?, submission_key? }
 * The same submission_key returns the existing work order (no duplicate on a double submit).
 */
create or replace function public.maintenance_create_work_order(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company  uuid := private.require_company();
  v_key      uuid := nullif(p ->> 'submission_key', '')::uuid;
  v_truck    uuid := nullif(p ->> 'truck_id', '')::uuid;
  v_driver   uuid := nullif(p ->> 'driver_id', '')::uuid;
  v_report   uuid := nullif(p ->> 'field_report_id', '')::uuid;
  v_assignee uuid := nullif(p ->> 'assigned_to', '')::uuid;
  v_sched    date := nullif(p ->> 'scheduled_for', '')::date;
  v_safety   boolean := coalesce((p ->> 'safety_critical')::boolean, false);
  v_existing public.work_orders%rowtype;
  v_id       uuid;
  v_number   text;
  v_status   text;
begin
  perform private.require_permission('maintenance.manage');
  if v_key is not null then
    select * into v_existing from public.work_orders where company_id = v_company and submission_key = v_key;
    if found then
      return jsonb_build_object('id', v_existing.id, 'number', v_existing.number, 'duplicate', true);
    end if;
  end if;
  if not exists (select 1 from public.trucks where id = v_truck and company_id = v_company) then
    raise exception 'Choose a truck.' using errcode = 'P0002';
  end if;
  perform private.wo_validate_refs(v_company, v_driver, v_assignee, v_report);
  if v_sched is not null and v_sched < private.business_today(v_company) then
    raise exception 'The scheduled date cannot be in the past.';
  end if;

  v_status := case when v_sched is not null then 'scheduled' else 'reported' end;
  v_number := private.next_document_number(v_company, 'work_order');
  insert into public.work_orders (company_id, number, truck_id, driver_id, field_report_id, title, description,
    category, urgency, safety_critical, status, assigned_to, scheduled_for, due_on, source, submission_key, created_by)
  values (v_company, v_number, v_truck, v_driver, v_report,
    private.clean_text(p ->> 'title', 120, 'Title'), private.clean_text(p ->> 'description', 4000, 'Description'),
    coalesce(nullif(p ->> 'category', ''), 'repair'), coalesce(nullif(p ->> 'urgency', ''), 'normal'),
    v_safety, v_status, v_assignee, v_sched, nullif(p ->> 'due_on', '')::date,
    case when v_report is not null then 'field_report' else 'manual' end, v_key, auth.uid())
  returning id into v_id;

  perform private.wo_event(v_company, v_id, 'created', null, v_status, '');
  if v_sched is not null then
    perform private.wo_event(v_company, v_id, 'scheduled', null, null, '', jsonb_build_object('scheduled_for', v_sched));
  end if;
  if v_safety then
    perform private.wo_restrict_truck(v_id);
  end if;
  return jsonb_build_object('id', v_id, 'number', v_number, 'duplicate', false);
exception
  when unique_violation then
    -- A concurrent submit with the same key won the race.
    select * into v_existing from public.work_orders where company_id = v_company and submission_key = v_key;
    if found then
      return jsonb_build_object('id', v_existing.id, 'number', v_existing.number, 'duplicate', true);
    end if;
    raise;
end;
$$;

/**
 * Edit a work order's details. p: { title, description, category, urgency, safety_critical, driver_id,
 * assigned_to, scheduled_for, due_on, findings, labor_hours, odometer_at_service, engine_hours_at_service }
 * Keys left out keep their value. p_expected_seq guards against overwriting someone else's change.
 */
create or replace function public.maintenance_update_work_order(p_id uuid, p_expected_seq integer, p jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v_wo      public.work_orders%rowtype;
  v_new     public.work_orders%rowtype;
begin
  perform private.require_permission('maintenance.manage');
  select * into v_wo from public.work_orders where id = p_id and company_id = v_company for update;
  if not found then
    raise exception 'Work order not found.' using errcode = 'P0002';
  end if;
  if p_expected_seq is not null and p_expected_seq <> v_wo.edit_seq then
    raise exception 'This work order was changed by someone else while you were editing. Reload to see the latest version.'
      using errcode = 'PT409';
  end if;
  if v_wo.status in ('closed', 'canceled') then
    raise exception 'This work order is % and can no longer be edited.', v_wo.status;
  end if;

  v_new := v_wo;
  if p ? 'title' then v_new.title := private.clean_text(p ->> 'title', 120, 'Title'); end if;
  if p ? 'description' then v_new.description := private.clean_text(p ->> 'description', 4000, 'Description'); end if;
  if p ? 'category' then v_new.category := p ->> 'category'; end if;
  if p ? 'urgency' then v_new.urgency := p ->> 'urgency'; end if;
  if p ? 'safety_critical' then v_new.safety_critical := coalesce((p ->> 'safety_critical')::boolean, false); end if;
  if p ? 'driver_id' then v_new.driver_id := nullif(p ->> 'driver_id', '')::uuid; end if;
  if p ? 'assigned_to' then v_new.assigned_to := nullif(p ->> 'assigned_to', '')::uuid; end if;
  if p ? 'scheduled_for' then v_new.scheduled_for := nullif(p ->> 'scheduled_for', '')::date; end if;
  if p ? 'due_on' then v_new.due_on := nullif(p ->> 'due_on', '')::date; end if;
  if p ? 'findings' then v_new.findings := private.clean_text(p ->> 'findings', 4000, 'Findings'); end if;
  if p ? 'labor_hours' then v_new.labor_hours := nullif(p ->> 'labor_hours', '')::numeric; end if;
  if p ? 'odometer_at_service' then v_new.odometer_at_service := nullif(p ->> 'odometer_at_service', '')::numeric; end if;
  if p ? 'engine_hours_at_service' then v_new.engine_hours_at_service := nullif(p ->> 'engine_hours_at_service', '')::numeric; end if;

  perform private.wo_validate_refs(v_company, v_new.driver_id, v_new.assigned_to, null);
  if v_wo.safety_critical and not v_new.safety_critical then
    if not private.has_permission('maintenance.clear') then
      raise exception 'Only someone who can clear vehicles for service may remove the safety-critical flag.' using errcode = '42501';
    end if;
  end if;
  if v_new.safety_critical and not v_wo.safety_critical and v_wo.status = 'completed' then
    raise exception 'Reopen the work order (back to in progress) before marking it safety-critical.' using errcode = 'P0001';
  end if;
  if v_new.scheduled_for is distinct from v_wo.scheduled_for and v_new.scheduled_for is not null
     and v_new.scheduled_for < private.business_today(v_company) then
    raise exception 'The scheduled date cannot be in the past.';
  end if;
  if v_new.scheduled_for is null and v_wo.status = 'scheduled' then
    raise exception 'A scheduled work order needs a date. Move it back to triaged to remove the date.';
  end if;

  update public.work_orders set
    title = v_new.title, description = v_new.description, category = v_new.category, urgency = v_new.urgency,
    safety_critical = v_new.safety_critical, driver_id = v_new.driver_id, assigned_to = v_new.assigned_to,
    scheduled_for = v_new.scheduled_for, due_on = v_new.due_on, findings = v_new.findings,
    labor_hours = v_new.labor_hours, odometer_at_service = v_new.odometer_at_service,
    engine_hours_at_service = v_new.engine_hours_at_service,
    -- Downgrading safety releases the clearance requirement for this order only.
    clearance_status = case when v_wo.safety_critical and not v_new.safety_critical and v_wo.clearance_status <> 'cleared'
                            then null else v_wo.clearance_status end,
    edit_seq = v_wo.edit_seq + 1, updated_by = auth.uid(), updated_at = now()
  where id = p_id;

  perform private.wo_event(v_company, p_id, 'updated', null, null, '');
  if v_new.assigned_to is distinct from v_wo.assigned_to then
    perform private.wo_event(v_company, p_id, 'assigned', null, null, '', jsonb_build_object('assigned_to', v_new.assigned_to));
  end if;
  if v_new.scheduled_for is distinct from v_wo.scheduled_for then
    perform private.wo_event(v_company, p_id,
      case when v_wo.scheduled_for is null then 'scheduled' when v_new.scheduled_for is null then 'unscheduled' else 'rescheduled' end,
      null, null, '', jsonb_build_object('from', v_wo.scheduled_for, 'scheduled_for', v_new.scheduled_for));
  end if;
  if v_new.safety_critical and not v_wo.safety_critical then
    perform private.wo_restrict_truck(p_id);
  elsif v_wo.safety_critical and not v_new.safety_critical then
    perform private.wo_release_truck(p_id);
  end if;
  return v_wo.edit_seq + 1;
end;
$$;

/** Move a work order along its lifecycle. Invalid transitions are refused with a reason. */
create or replace function public.maintenance_set_status(p_id uuid, p_status text, p_note text default '', p_expected_seq integer default null)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v_wo      public.work_orders%rowtype;
  v_note    text := private.clean_text(p_note, 2000, 'Note');
begin
  perform private.require_permission('maintenance.manage');
  select * into v_wo from public.work_orders where id = p_id and company_id = v_company for update;
  if not found then
    raise exception 'Work order not found.' using errcode = 'P0002';
  end if;
  if p_expected_seq is not null and p_expected_seq <> v_wo.edit_seq then
    raise exception 'This work order was changed by someone else. Reload to see the latest version.' using errcode = 'PT409';
  end if;
  if v_wo.status = 'awaiting_inspection' then
    raise exception 'This work order is waiting for inspection. An authorized inspector records the result in the clearance queue.'
      using errcode = 'P0001';
  end if;
  if not private.wo_transition_ok(v_wo.status, p_status) then
    raise exception 'A work order cannot go from % to %.', replace(v_wo.status, '_', ' '), replace(coalesce(p_status, '?'), '_', ' ')
      using errcode = 'P0001';
  end if;
  if p_status = 'completed' and v_wo.safety_critical then
    raise exception 'Safety-critical repairs cannot be completed directly. Send the work order for inspection.' using errcode = 'P0001';
  end if;
  if p_status = 'scheduled' and v_wo.scheduled_for is null then
    raise exception 'Set a scheduled date first.' using errcode = 'P0001';
  end if;
  if p_status = 'canceled' then
    if length(v_note) = 0 then
      raise exception 'Enter a reason for canceling.' using errcode = 'P0001';
    end if;
    if v_wo.safety_critical and not private.has_permission('maintenance.clear') then
      raise exception 'Only someone who can clear vehicles for service may cancel a safety-critical work order.' using errcode = '42501';
    end if;
  end if;

  update public.work_orders set
    status = p_status,
    clearance_status = case when p_status = 'awaiting_inspection' then 'awaiting'
                            when p_status = 'in_progress' and v_wo.status = 'completed' then null
                            else clearance_status end,
    completed_at = case when p_status = 'completed' then now() when p_status = 'in_progress' then null else completed_at end,
    closed_at = case when p_status = 'closed' then now() else closed_at end,
    cancel_reason = case when p_status = 'canceled' then v_note else cancel_reason end,
    edit_seq = edit_seq + 1, updated_by = auth.uid(), updated_at = now()
  where id = p_id;

  perform private.wo_event(v_company, p_id, case when p_status = 'canceled' then 'canceled' else 'status' end,
    v_wo.status, p_status, v_note, jsonb_build_object('scheduled_for', v_wo.scheduled_for));
  if p_status = 'completed' then
    perform private.wo_complete_schedule(p_id);
  end if;
  -- A reopened safety repair restricts the truck again.
  if p_status = 'in_progress' and v_wo.status = 'completed' and v_wo.safety_critical then
    perform private.wo_restrict_truck(p_id);
  end if;
  if p_status = 'canceled' and v_wo.safety_critical then
    perform private.wo_release_truck(p_id);
  end if;
  return v_wo.edit_seq + 1;
end;
$$;

-- -----------------------------------------------------------------------------
-- Clearance (maintenance.clear)
-- -----------------------------------------------------------------------------
create or replace function public.maintenance_start_inspection(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v_wo      public.work_orders%rowtype;
begin
  perform private.require_permission('maintenance.clear');
  select * into v_wo from public.work_orders where id = p_id and company_id = v_company for update;
  if not found then
    raise exception 'Work order not found.' using errcode = 'P0002';
  end if;
  if v_wo.status <> 'awaiting_inspection' or v_wo.clearance_status <> 'awaiting' then
    raise exception 'Only a work order waiting for inspection can be started.' using errcode = 'P0001';
  end if;
  update public.work_orders set clearance_status = 'in_progress', inspector_id = auth.uid(),
    edit_seq = edit_seq + 1, updated_by = auth.uid(), updated_at = now()
  where id = p_id;
  perform private.wo_event(v_company, p_id, 'inspection_started', null, null, '');
end;
$$;

/** Record the inspection: 'passed' completes the work order (and may return the truck); 'failed' sends it back to work. */
create or replace function public.maintenance_record_clearance(p_id uuid, p_outcome text, p_notes text default '')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company  uuid := private.require_company();
  v_wo       public.work_orders%rowtype;
  v_notes    text := private.clean_text(p_notes, 2000, 'Notes');
  v_returned boolean := false;
begin
  perform private.require_permission('maintenance.clear');
  select * into v_wo from public.work_orders where id = p_id and company_id = v_company for update;
  if not found then
    raise exception 'Work order not found.' using errcode = 'P0002';
  end if;
  if v_wo.status <> 'awaiting_inspection' then
    raise exception 'This work order is not waiting for inspection.' using errcode = 'P0001';
  end if;
  if p_outcome not in ('passed', 'failed') then
    raise exception 'Choose passed or failed.';
  end if;
  if p_outcome = 'failed' and length(v_notes) = 0 then
    raise exception 'Describe what failed so the shop knows what to fix.' using errcode = 'P0001';
  end if;

  if p_outcome = 'passed' then
    update public.work_orders set status = 'completed', clearance_status = 'cleared',
      inspector_id = coalesce(inspector_id, auth.uid()), cleared_by = auth.uid(), cleared_at = now(),
      clearance_notes = v_notes, completed_at = now(),
      edit_seq = edit_seq + 1, updated_by = auth.uid(), updated_at = now()
    where id = p_id;
    perform private.wo_event(v_company, p_id, 'cleared', 'awaiting_inspection', 'completed', v_notes);
    perform private.wo_complete_schedule(p_id);
    v_returned := private.wo_release_truck(p_id);
  else
    update public.work_orders set status = 'in_progress', clearance_status = 'failed',
      inspector_id = coalesce(inspector_id, auth.uid()), clearance_notes = v_notes, completed_at = null,
      edit_seq = edit_seq + 1, updated_by = auth.uid(), updated_at = now()
    where id = p_id;
    perform private.wo_event(v_company, p_id, 'inspection_failed', 'awaiting_inspection', 'in_progress', v_notes);
  end if;
  perform private.log_event('maintenance_clearance_' || p_outcome, 'work_order', p_id,
    'Inspection ' || p_outcome || ' for work order ' || v_wo.number, jsonb_build_object('returned_to_service', v_returned));
  return jsonb_build_object('outcome', p_outcome, 'returned_to_service', v_returned);
end;
$$;

-- -----------------------------------------------------------------------------
-- Preventive work orders: create one per due schedule, never twice.
-- -----------------------------------------------------------------------------
create or replace function public.maintenance_generate_due()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v_row     record;
  v_id      uuid;
  v_count   integer := 0;
begin
  perform private.require_permission('maintenance.manage');
  -- One generator per company at a time; the unique index is the backstop.
  perform pg_advisory_xact_lock(hashtext('maintenance_generate_due:' || v_company::text));
  for v_row in
    select d.* from private.pm_due(v_company) d
    where d.state in ('overdue', 'due_soon') and d.open_work_order_id is null
  loop
    insert into public.work_orders (company_id, number, truck_id, schedule_id, title, description, category, urgency,
      status, due_on, source, created_by)
    values (v_company, private.next_document_number(v_company, 'work_order'), v_row.truck_id, v_row.schedule_id,
      left(v_row.name, 120),
      'Preventive maintenance ' || replace(v_row.state, '_', ' ') || '.',
      'preventive', case when v_row.state = 'overdue' then 'high' else 'normal' end,
      'reported', v_row.next_due_on, 'preventive', auth.uid())
    on conflict (schedule_id) where schedule_id is not null and status not in ('completed', 'closed', 'canceled')
    do nothing
    returning id into v_id;
    if v_id is not null then
      perform private.wo_event(v_company, v_id, 'created', null, 'reported', 'Created from preventive schedule',
        jsonb_build_object('schedule_id', v_row.schedule_id, 'state', v_row.state));
      v_count := v_count + 1;
      v_id := null;
    end if;
  end loop;
  return v_count;
end;
$$;

-- -----------------------------------------------------------------------------
-- Driver notices (My Day): maintenance scheduled, rescheduled or canceled on
-- the driver's primary truck or naming the driver. No costs or findings.
-- -----------------------------------------------------------------------------
create or replace function public.driver_maintenance_notices()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v_driver  public.drivers%rowtype;
  v_today   date := private.business_today(v_company);
begin
  select * into v_driver from public.drivers
  where company_id = v_company and user_id = auth.uid() and active
  limit 1;
  if not found then
    return '[]'::jsonb;
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'number', w.number, 'unit_number', t.unit_number, 'title', w.title, 'status', w.status,
      'scheduled_for', w.scheduled_for, 'safety_critical', w.safety_critical,
      'notice', e.kind, 'notice_at', e.created_at, 'previous_date', e.details ->> 'from')
      order by coalesce(w.scheduled_for, v_today), w.number)
    from public.work_orders w
    join public.trucks t on t.company_id = w.company_id and t.id = w.truck_id
    join lateral (
      select ev.kind, ev.created_at, ev.details from public.work_order_events ev
      where ev.company_id = w.company_id and ev.work_order_id = w.id
        and ev.kind in ('scheduled', 'rescheduled', 'canceled')
      order by ev.created_at desc limit 1) e on true
    where w.company_id = v_company
      and (w.truck_id = v_driver.primary_truck_id or w.driver_id = v_driver.id)
      and ((w.status not in ('completed', 'closed', 'canceled') and w.scheduled_for >= v_today - 1)
           or (w.status = 'canceled' and e.kind = 'canceled' and e.created_at > now() - interval '7 days'
               and (e.details ->> 'scheduled_for') is not null))
  ), '[]'::jsonb);
end;
$$;

-- People who can be assigned shop work: active members whose role has
-- maintenance.manage in this company. Names and roles only.
create or replace function public.maintenance_assignee_options()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
begin
  perform private.require_permission('maintenance.view');
  return coalesce((
    select jsonb_agg(jsonb_build_object('user_id', m.user_id, 'name', coalesce(nullif(trim(p.full_name), ''), 'Unnamed user'),
                                        'role', m.role) order by p.full_name)
    from public.company_memberships m
    join public.profiles p on p.id = m.user_id
    where m.company_id = v_company and m.active
      and exists (select 1 from public.role_permissions rp
                  where rp.company_id = v_company and rp.role = m.role and rp.permission = 'maintenance.manage')
  ), '[]'::jsonb);
end;
$$;

revoke execute on function public.record_truck_reading(uuid, numeric, numeric, text),
  public.maintenance_save_schedule(jsonb), public.maintenance_create_work_order(jsonb),
  public.maintenance_update_work_order(uuid, integer, jsonb), public.maintenance_set_status(uuid, text, text, integer),
  public.maintenance_start_inspection(uuid), public.maintenance_record_clearance(uuid, text, text),
  public.maintenance_generate_due(), public.driver_maintenance_notices(), public.maintenance_pm_status(),
  public.maintenance_assignee_options()
  from public, anon;
grant execute on function public.record_truck_reading(uuid, numeric, numeric, text),
  public.maintenance_save_schedule(jsonb), public.maintenance_create_work_order(jsonb),
  public.maintenance_update_work_order(uuid, integer, jsonb), public.maintenance_set_status(uuid, text, text, integer),
  public.maintenance_start_inspection(uuid), public.maintenance_record_clearance(uuid, text, text),
  public.maintenance_generate_due(), public.driver_maintenance_notices(), public.maintenance_pm_status(),
  public.maintenance_assignee_options()
  to authenticated;
revoke execute on function private.wo_restrict_truck(uuid), private.wo_release_truck(uuid),
  private.add_work_order_sequence() from public, anon, authenticated;
