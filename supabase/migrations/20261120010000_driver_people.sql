-- =============================================================================
-- Every driver is in People (owner decision 2026-11-09, master plan WK1): Fleet and People become one list.
--
-- * Backfill: every driver of the company's own without a People record (public.employees.driver_id) gets one: same
--   company, the driver's name, phone and hire date, linked by driver_id, status active or inactive from the driver.
--   A driver with a login first joins that login's People record when it has no driver yet (no second record for the
--   same person); otherwise a new record carries the login only when no other record holds it (unique per company).
--   Idempotent: drivers already linked are skipped (employees_driver_key stays one record per driver).
-- * From now on a trigger does the same for every driver however it is created (Fleet "Add driver", company imports,
--   demo seeds, scripts), and keeps the record in step:
--     - a rename in Fleet renames the People record only while its name still equals the old driver name (a name
--       changed in People is never overwritten);
--     - deactivating or reactivating a driver without a login sets the People record inactive or active (only from
--       active or inactive: on leave and terminated are People decisions and stay);
--     - a login linked to the driver later joins the People record when it has none and the login has no record yet;
--     - a new driver record for a login whose People record still sits on a driver that is no longer this login's
--       (moved off it in Fleet) takes that record; the earlier driver gets its own record (so nobody is listed twice
--       under one login and every driver stays in People).
-- * Hired-truck drivers (drivers.hauler_id set, migration 20261120003700) are drivers of another company (the hauler):
--   they are not this company's staff and get no People record. They are counted apart on every page.
--
-- The functions are SECURITY DEFINER so a person who may add drivers (fleet.edit) but not edit People still gets the
-- People record; they act only on the inserted or updated driver's own company (new.company_id) and are reviewed in
-- tests/db/tenancy.test.ts.
--
-- Reversible: supabase/rollbacks/20261120010000_driver_people.down.sql removes the triggers and functions. The People
-- records created here stay (they are ordinary records that time off, schedules and pay may already reference).
-- =============================================================================

-- The People record of one driver, when it has none: a driver with a login joins that login's record when the record
-- has no driver yet; otherwise a new record (carrying the login only when no other record holds it). Hired-truck
-- drivers get none. Called only from the trigger functions below (no grant).
create or replace function private.driver_person_add(p_driver uuid)
returns void
language plpgsql
set search_path = ''
as $$
declare
  d      public.drivers%rowtype;
  v_user uuid;
  v_name text;
begin
  select * into d from public.drivers where id = p_driver;
  if not found or d.hauler_id is not null then
    return;
  end if;
  if exists (select 1 from public.employees e where e.company_id = d.company_id and e.driver_id = d.id) then
    return;
  end if;
  v_user := d.user_id;
  if d.user_id is not null then
    update public.employees e set driver_id = d.id
     where e.company_id = d.company_id and e.user_id = d.user_id and e.driver_id is null;
    if found then
      return;
    end if;
    if exists (select 1 from public.employees e where e.company_id = d.company_id and e.user_id = d.user_id) then
      v_user := null;
    end if;
  end if;
  -- The name Fleet shows (driver_list): the driver's own name in a demo company, otherwise the login's name first.
  select coalesce(
           case when c.is_demo then nullif(trim(d.name), '') end,
           (select nullif(trim(p.full_name), '') from public.profiles p where p.id = d.user_id),
           nullif(trim(d.name), ''),
           'Unnamed driver')
    into v_name
    from public.companies c where c.id = d.company_id;
  insert into public.employees (company_id, user_id, driver_id, full_name, department, status, hire_date, work_phone)
  values (d.company_id, v_user, d.id, left(coalesce(v_name, 'Unnamed driver'), 120), 'operations',
          case when d.active then 'active' else 'inactive' end, d.hire_date, left(coalesce(d.phone, ''), 40));
end;
$$;

revoke all on function private.driver_person_add(uuid) from public, anon, authenticated;

create or replace function private.driver_person_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_emp uuid;
  v_old uuid;
begin
  if new.hauler_id is not null then
    return null;
  end if;
  -- A new driver record for a login whose People record still sits on a driver that is no longer this login's (the
  -- login was moved off it in Fleet): the person's record follows the login; the earlier driver gets its own record.
  if new.user_id is not null
     and not exists (select 1 from public.employees e where e.company_id = new.company_id and e.driver_id = new.id) then
    select e.id, e.driver_id into v_emp, v_old
      from public.employees e
     where e.company_id = new.company_id and e.user_id = new.user_id and e.driver_id is not null
       and not exists (select 1 from public.drivers x where x.id = e.driver_id and x.user_id = new.user_id);
    if v_emp is not null then
      update public.employees set driver_id = new.id where id = v_emp;
      perform private.driver_person_add(v_old);
      return null;
    end if;
  end if;
  perform private.driver_person_add(new.id);
  return null;
end;
$$;

create or replace function private.driver_person_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.hauler_id is not null then
    return null;
  end if;
  if new.name is distinct from old.name and length(trim(new.name)) > 0 then
    update public.employees e set full_name = left(regexp_replace(trim(new.name), '\s+', ' ', 'g'), 120)
     where e.company_id = new.company_id and e.driver_id = new.id
       and e.full_name = regexp_replace(trim(old.name), '\s+', ' ', 'g');
  end if;
  if new.active is distinct from old.active then
    update public.employees e set status = case when new.active then 'active' else 'inactive' end
     where e.company_id = new.company_id and e.driver_id = new.id and e.user_id is null
       and e.status = case when new.active then 'inactive' else 'active' end;
  end if;
  if new.user_id is not null and new.user_id is distinct from old.user_id
     and not exists (select 1 from public.employees x where x.company_id = new.company_id and x.user_id = new.user_id) then
    update public.employees e set user_id = new.user_id
     where e.company_id = new.company_id and e.driver_id = new.id and e.user_id is null;
  end if;
  return null;
end;
$$;

revoke all on function private.driver_person_insert() from public, anon, authenticated;
revoke all on function private.driver_person_update() from public, anon, authenticated;

create trigger driver_person_insert after insert on public.drivers
  for each row execute function private.driver_person_insert();
create trigger driver_person_update after update of name, active, user_id on public.drivers
  for each row execute function private.driver_person_update();

-- -----------------------------------------------------------------------------
-- Backfill (idempotent)
-- -----------------------------------------------------------------------------
-- A login's People record still on a driver that is no longer this login's moves to the login's driver (when that
-- driver has no record yet); the earlier driver then gets its own record below.
with stale as (
  select e.id as employee_id, d.id as driver_id
    from public.drivers d
    join public.employees e on e.company_id = d.company_id and e.user_id = d.user_id
   where d.hauler_id is null and e.driver_id is not null
     and not exists (select 1 from public.employees x where x.company_id = d.company_id and x.driver_id = d.id)
     and not exists (select 1 from public.drivers y where y.id = e.driver_id and y.user_id = d.user_id)
)
update public.employees e set driver_id = s.driver_id from stale s where e.id = s.employee_id;

-- A driver with a login joins that login's People record when the record has no driver yet.
update public.employees e
   set driver_id = d.id
  from public.drivers d
 where d.company_id = e.company_id and d.user_id = e.user_id and e.driver_id is null and d.hauler_id is null
   and not exists (select 1 from public.employees x where x.company_id = d.company_id and x.driver_id = d.id);

-- Every other driver of the company's own gets a People record.
insert into public.employees (company_id, user_id, driver_id, full_name, department, status, hire_date, work_phone)
select d.company_id,
       case when d.user_id is not null
                 and not exists (select 1 from public.employees x where x.company_id = d.company_id and x.user_id = d.user_id)
            then d.user_id end,
       d.id,
       left(coalesce(case when c.is_demo then nullif(trim(d.name), '') end,
                     nullif(trim(p.full_name), ''),
                     nullif(trim(d.name), ''),
                     'Unnamed driver'), 120),
       'operations',
       case when d.active then 'active' else 'inactive' end,
       d.hire_date,
       left(coalesce(d.phone, ''), 40)
  from public.drivers d
  join public.companies c on c.id = d.company_id
  left join public.profiles p on p.id = d.user_id
 where d.hauler_id is null
   and not exists (select 1 from public.employees x where x.company_id = d.company_id and x.driver_id = d.id);
