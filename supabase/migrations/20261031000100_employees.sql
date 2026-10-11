-- =============================================================================
-- Employees: a company's people directory, employment records, confidential
-- compensation, and each driver's primary (default) truck.
--
-- * public.employees — one record per person who works for the company. A record
--   is NOT a login: user_id links it to an account when the person has one, and
--   driver_id links it to their driver record (qualifications, dispatch). Prefilled
--   from existing company memberships and drivers.
-- * public.employee_compensation — pay details, readable and editable only with
--   'employees.compensation'. Kept in its own table so no other permission can
--   ever see it (row-level security cannot hide single columns).
-- * public.drivers.primary_truck_id — the truck a driver normally uses every day.
--   Changing it needs 'fleet.assign' (enforced by a trigger, whatever the path);
--   a truck is the primary truck of at most one active driver. Maintenance
--   substitutions are dispatch assignments and never change this field.
--
-- Permissions (per role, editable by owners like every other permission):
--   employees.view          see the directory and employment details
--   employees.edit          add and edit employee records (not roles or access)
--   employees.compensation  see and change pay (confidential)
--   fleet.assign            set or change drivers' primary trucks
-- Roles and sign-in access stay with 'users.manage' (Settings → Users).
--
-- Additive: no existing row is changed. Rollback:
-- supabase/rollbacks/20261031000100_employees.down.sql
-- =============================================================================

insert into public.permissions (code, category, description) values
  ('employees.view',         'Employees', 'View the employee directory and employment details'),
  ('employees.edit',         'Employees', 'Add and edit employee records (not roles or sign-in access)'),
  ('employees.compensation', 'Employees', 'View and change confidential pay details'),
  ('fleet.assign',           'Fleet',     'Set or change the primary truck a driver uses each day');

insert into public.role_permission_defaults (role, permission) values
  ('owner', 'employees.view'), ('owner', 'employees.edit'), ('owner', 'employees.compensation'), ('owner', 'fleet.assign'),
  ('office', 'employees.view'), ('office', 'employees.edit'),
  ('dispatcher', 'employees.view'), ('dispatcher', 'fleet.assign'),
  ('mechanic', 'employees.view');

insert into public.role_permissions (company_id, role, permission)
select c.id, d.role, d.permission
from public.companies c
cross join public.role_permission_defaults d
where d.permission in ('employees.view', 'employees.edit', 'employees.compensation', 'fleet.assign')
on conflict do nothing;

-- -----------------------------------------------------------------------------
-- Employees
-- -----------------------------------------------------------------------------
create table public.employees (
  id                      uuid primary key default gen_random_uuid(),
  company_id              uuid not null default private.current_company_id() references public.companies (id),
  user_id                 uuid,
  driver_id               uuid,
  full_name               text not null check (length(trim(full_name)) between 1 and 120),
  job_title               text not null default '' check (length(job_title) <= 80),
  department              text not null default 'operations'
    check (department in ('operations', 'dispatch', 'office', 'shop', 'sales', 'management', 'other')),
  employment_type         text not null default 'full_time'
    check (employment_type in ('full_time', 'part_time', 'seasonal', 'contractor')),
  status                  text not null default 'active'
    check (status in ('active', 'on_leave', 'inactive', 'terminated')),
  hire_date               date,
  end_date                date,
  work_email              text not null default '' check (length(work_email) <= 200),
  work_phone              text not null default '' check (length(work_phone) <= 40),
  emergency_contact_name  text not null default '' check (length(emergency_contact_name) <= 120),
  emergency_contact_phone text not null default '' check (length(emergency_contact_phone) <= 40),
  notes                   text not null default '' check (length(notes) <= 4000),
  created_by              uuid default auth.uid() references auth.users (id) on delete set null,
  created_at              timestamptz not null default now(),
  updated_by              uuid references auth.users (id) on delete set null,
  updated_at              timestamptz not null default now(),
  unique (company_id, id),
  constraint employees_member_fk foreign key (company_id, user_id)
    references public.company_memberships (company_id, user_id) on delete restrict,
  constraint employees_driver_fk foreign key (company_id, driver_id)
    references public.drivers (company_id, id) on delete restrict,
  constraint employees_dates check (end_date is null or hire_date is null or end_date >= hire_date),
  constraint employees_ended check (status <> 'terminated' or end_date is not null)
);
create unique index employees_user_key on public.employees (company_id, user_id) where user_id is not null;
create unique index employees_driver_key on public.employees (company_id, driver_id) where driver_id is not null;
create index employees_name_idx on public.employees (company_id, lower(full_name));

create table public.employee_compensation (
  employee_id     uuid primary key,
  company_id      uuid not null default private.current_company_id() references public.companies (id),
  pay_type        text not null check (pay_type in ('hourly', 'salary', 'per_load', 'percentage', 'other')),
  rate_cents      bigint check (rate_cents is null or rate_cents between 0 and 100000000000),
  rate_percent    numeric(6, 3) check (rate_percent is null or rate_percent between 0 and 100),
  effective_date  date,
  notes           text not null default '' check (length(notes) <= 2000),
  updated_by      uuid default auth.uid() references auth.users (id) on delete set null,
  updated_at      timestamptz not null default now(),
  foreign key (company_id, employee_id) references public.employees (company_id, id) on delete cascade,
  constraint employee_compensation_amount check (
    (pay_type = 'percentage' and rate_percent is not null and rate_cents is null)
    or (pay_type <> 'percentage' and rate_percent is null))
);

create or replace function private.stamp_employee_row()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_by := auth.uid();
  new.updated_at := now();
  if tg_table_name = 'employees' then
    new.full_name := regexp_replace(trim(new.full_name), '\s+', ' ', 'g');
    new.job_title := trim(new.job_title);
  end if;
  return new;
end;
$$;

create trigger employees_stamp before insert or update on public.employees
  for each row execute function private.stamp_employee_row();
create trigger employee_compensation_stamp before insert or update on public.employee_compensation
  for each row execute function private.stamp_employee_row();
create trigger a_company_guard before update of company_id on public.employees
  for each row execute function private.forbid_company_change();
create trigger a_company_guard before update of company_id on public.employee_compensation
  for each row execute function private.forbid_company_change();
create trigger employees_audit after insert or update or delete on public.employees
  for each row execute function private.audit_row_change('employee');
-- Compensation changes are audited without their amounts: the audit log is
-- readable with 'audit.view', which must not reveal pay.
create or replace function private.audit_compensation_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.log_event(
    'compensation_' || lower(tg_op), 'employee', coalesce(new.employee_id, old.employee_id),
    'Pay details changed', jsonb_build_object('note', 'Amounts are not recorded in the audit log'));
  return null;
end;
$$;
create trigger employee_compensation_audit after insert or update or delete on public.employee_compensation
  for each row execute function private.audit_compensation_change();

alter table public.employees enable row level security;
alter table public.employee_compensation enable row level security;

-- Directory: employees.view within the company; everyone may read their own record.
create policy employees_read on public.employees for select to authenticated
  using (company_id = (select private.current_company_id())
         and ((select private.has_permission('employees.view')) or user_id = (select auth.uid())));
create policy employees_insert on public.employees for insert to authenticated
  with check (company_id = (select private.current_company_id()) and (select private.has_permission('employees.edit')));
create policy employees_update on public.employees for update to authenticated
  using (company_id = (select private.current_company_id()) and (select private.has_permission('employees.edit')))
  with check (company_id = (select private.current_company_id()) and (select private.has_permission('employees.edit')));
-- No delete: people are marked inactive or terminated, so history keeps its names.

create policy employee_compensation_read on public.employee_compensation for select to authenticated
  using (company_id = (select private.current_company_id()) and (select private.has_permission('employees.compensation')));
create policy employee_compensation_insert on public.employee_compensation for insert to authenticated
  with check (company_id = (select private.current_company_id()) and (select private.has_permission('employees.compensation')));
create policy employee_compensation_update on public.employee_compensation for update to authenticated
  using (company_id = (select private.current_company_id()) and (select private.has_permission('employees.compensation')))
  with check (company_id = (select private.current_company_id()) and (select private.has_permission('employees.compensation')));
create policy employee_compensation_delete on public.employee_compensation for delete to authenticated
  using (company_id = (select private.current_company_id()) and (select private.has_permission('employees.compensation')));

revoke all on public.employees, public.employee_compensation from anon;
revoke delete, truncate on public.employees from authenticated;
grant select, insert, update on public.employees to authenticated;
grant select, insert, update, delete on public.employee_compensation to authenticated;

-- Prefill: one employee per member of each company, and one per driver (linked
-- to the member's record when the driver has a login).
insert into public.employees (company_id, user_id, full_name, department, status, work_email)
select m.company_id, m.user_id,
       coalesce(nullif(trim(p.full_name), ''), split_part(p.email, '@', 1)),
       case m.role when 'dispatcher' then 'dispatch' when 'mechanic' then 'shop' when 'office' then 'office'
                   when 'owner' then 'management' else 'operations' end,
       case when m.active then 'active' else 'inactive' end,
       p.email
from public.company_memberships m
join public.profiles p on p.id = m.user_id
on conflict do nothing;

update public.employees e
set driver_id = d.id
from public.drivers d
where d.company_id = e.company_id and d.user_id = e.user_id and e.driver_id is null;

insert into public.employees (company_id, driver_id, full_name, department, status, hire_date, work_phone)
select d.company_id, d.id, d.name, 'operations', case when d.active then 'active' else 'inactive' end, d.hire_date, d.phone
from public.drivers d
where d.user_id is null and length(trim(d.name)) > 0
  and not exists (select 1 from public.employees e where e.company_id = d.company_id and e.driver_id = d.id);

-- -----------------------------------------------------------------------------
-- Primary truck per driver
-- -----------------------------------------------------------------------------
alter table public.drivers add column primary_truck_id uuid;
alter table public.drivers add constraint drivers_primary_truck_fk
  foreign key (company_id, primary_truck_id) references public.trucks (company_id, id) on delete restrict;
create unique index drivers_primary_truck_key on public.drivers (company_id, primary_truck_id)
  where primary_truck_id is not null and active;

create or replace function private.guard_primary_truck()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.primary_truck_id is distinct from (case when tg_op = 'UPDATE' then old.primary_truck_id end)
     and auth.uid() is not null and not private.has_permission('fleet.assign') then
    raise exception 'You do not have permission to assign trucks to drivers.' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger drivers_primary_truck_guard before insert or update on public.drivers
  for each row execute function private.guard_primary_truck();

/** Set (or clear, with null) a driver's primary truck. Needs fleet.assign; same company only. */
create or replace function public.set_driver_primary_truck(p_driver_id uuid, p_truck_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v_holder  text;
begin
  perform private.require_permission('fleet.assign');
  if not exists (select 1 from public.drivers where id = p_driver_id and company_id = v_company) then
    raise exception 'Driver not found.' using errcode = 'P0002';
  end if;
  if p_truck_id is not null then
    if not exists (select 1 from public.trucks where id = p_truck_id and company_id = v_company and active) then
      raise exception 'Truck not found or not active.' using errcode = 'P0002';
    end if;
    select d.name into v_holder from public.drivers d
    where d.company_id = v_company and d.primary_truck_id = p_truck_id and d.active and d.id <> p_driver_id;
    if v_holder is not null then
      raise exception 'That truck is already the primary truck of %. Unassign it there first.', v_holder using errcode = '23505';
    end if;
  end if;
  update public.drivers set primary_truck_id = p_truck_id where id = p_driver_id and company_id = v_company;
end;
$$;

revoke execute on function public.set_driver_primary_truck(uuid, uuid) from public, anon;
grant execute on function public.set_driver_primary_truck(uuid, uuid) to authenticated;
