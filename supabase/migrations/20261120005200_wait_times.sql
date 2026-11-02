-- =============================================================================
-- Wait times at pickups and job sites (B111, owner 2026-11-01: track only, no detention charges for now).
--
-- The driver taps Arrived / Left at the pickup (quarry, plant) and at the job site on My Day; the office can enter or
-- correct times. Wait = left − arrived. The company sets its free time (minutes); waits longer than that are flagged
-- and counted on Reports → Wait times by site. No free time set = waits are shown, nothing is flagged. Nothing is
-- billed or charged (owner decision 2026-11-01); a charge would be a separate, approved feature.
-- Writes: the load's assigned driver (own active assignment) or dispatch.edit. Reads: dispatch.view or billing.view,
-- and a driver their own loads. Settings: settings.manage.
-- Reversible: supabase/rollbacks/20261120005200_wait_times.down.sql
-- =============================================================================

create table public.wait_time_settings (
  company_id    uuid primary key default private.current_company_id() references public.companies (id),
  free_minutes  integer check (free_minutes is null or free_minutes between 5 and 480),
  updated_by    uuid default auth.uid() references auth.users (id) on delete set null,
  updated_at    timestamptz not null default now()
);

create table public.load_stop_times (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies (id),
  load_id      uuid not null,
  order_id     uuid not null,
  stop         text not null check (stop in ('pickup', 'site')),
  location_id  uuid references public.company_locations (id) on delete set null,
  arrived_at   timestamptz,
  departed_at  timestamptz,
  source       text not null default 'driver' check (source in ('driver', 'office', 'demo')),
  entered_by   uuid default auth.uid() references auth.users (id) on delete set null,
  updated_at   timestamptz not null default now(),
  unique (load_id, stop),
  check (departed_at is null or arrived_at is null or departed_at >= arrived_at),
  foreign key (company_id, load_id) references public.order_loads (company_id, id) on delete cascade,
  foreign key (company_id, order_id) references public.orders (company_id, id) on delete cascade
);
create index load_stop_times_company_arrived on public.load_stop_times (company_id, arrived_at);

alter table public.wait_time_settings enable row level security;
alter table public.load_stop_times enable row level security;
revoke all on public.wait_time_settings, public.load_stop_times from anon, authenticated;
grant select on public.wait_time_settings, public.load_stop_times to authenticated;

-- Whether the load is on the caller's own active assignment (drivers cannot read dispatch_assignments directly).
create or replace function private.is_my_load(p_load uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.dispatch_assignments a
                 where a.load_id = p_load and a.status = 'active' and a.driver_id = private.my_driver_id()
                   and a.company_id = private.current_company_id());
$$;
revoke all on function private.is_my_load(uuid) from public, anon;
grant execute on function private.is_my_load(uuid) to authenticated;

create policy wait_time_settings_read on public.wait_time_settings for select to authenticated
  using (company_id = (select private.current_company_id()));
create policy load_stop_times_read on public.load_stop_times for select to authenticated
  using (company_id = (select private.current_company_id())
         and ((select private.has_permission('dispatch.view')) or (select private.has_permission('billing.view'))
              or private.is_my_load(load_id)));

create or replace function public.wait_time_save_settings(p_free_minutes integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
begin
  perform private.require_permission('settings.manage');
  if p_free_minutes is not null and p_free_minutes not between 5 and 480 then
    raise exception 'Free time is 5 to 480 minutes, or empty for none.' using errcode = '22023';
  end if;
  insert into public.wait_time_settings (company_id, free_minutes) values (v_company, p_free_minutes)
  on conflict (company_id) do update set free_minutes = excluded.free_minutes, updated_by = auth.uid(), updated_at = now();
  perform private.log_event('wait_time.settings', 'company', v_company,
    case when p_free_minutes is null then 'Wait time: no free time set' else format('Wait time: %s free minutes', p_free_minutes) end,
    jsonb_build_object('free_minutes', p_free_minutes));
end;
$$;

-- The caller's right to write a load's stop times: dispatch editing, or the load's assigned driver.
create or replace function private.stop_time_writer(p_load uuid)
returns table (load_id uuid, order_id uuid, company_id uuid, own boolean)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  r record;
begin
  select l.id, l.order_id, l.company_id, private.is_my_load(l.id) as own
    into r
  from public.order_loads l where l.id = p_load and l.company_id = v_company;
  if r.id is null then
    raise exception 'Load not found.' using errcode = 'P0002';
  end if;
  if not r.own then
    perform private.require_permission('dispatch.edit');
  end if;
  return query select r.id, r.order_id, r.company_id, r.own;
end;
$$;

-- Arrived / Left, tapped now (by the driver on My Day, or the office). A repeated tap keeps the first time.
create or replace function public.load_stop_mark(p_load uuid, p_stop text, p_event text, p_location uuid default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
  v_row public.load_stop_times;
begin
  if p_stop not in ('pickup', 'site') or p_event not in ('arrive', 'depart') then
    raise exception 'Choose the stop and whether you arrived or left.' using errcode = '22023';
  end if;
  select * into r from private.stop_time_writer(p_load);
  if p_location is not null and (p_stop <> 'pickup' or not exists (
       select 1 from public.company_locations c where c.id = p_location and c.company_id = r.company_id and c.active)) then
    raise exception 'Location not found.' using errcode = 'P0002';
  end if;
  select * into v_row from public.load_stop_times where load_id = p_load and stop = p_stop;
  if p_event = 'depart' and v_row.arrived_at is null then
    raise exception 'Tap Arrived first.' using errcode = '22023';
  end if;
  insert into public.load_stop_times (company_id, load_id, order_id, stop, location_id, arrived_at, departed_at, source)
  values (r.company_id, p_load, r.order_id, p_stop, p_location, case when p_event = 'arrive' then now() end,
          null, case when r.own then 'driver' else 'office' end)
  on conflict (load_id, stop) do update set
    arrived_at = coalesce(public.load_stop_times.arrived_at, excluded.arrived_at),
    departed_at = case when p_event = 'depart' then coalesce(public.load_stop_times.departed_at, now()) else public.load_stop_times.departed_at end,
    location_id = coalesce(excluded.location_id, public.load_stop_times.location_id),
    entered_by = auth.uid(), updated_at = now();
end;
$$;

-- Office entry or correction of both times (dispatch.edit), e.g. from a paper log. Times up to 14 days back.
create or replace function public.load_stop_set(p_load uuid, p_stop text, p_arrived timestamptz, p_departed timestamptz, p_location uuid default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
begin
  perform private.require_permission('dispatch.edit');
  if p_stop not in ('pickup', 'site') then
    raise exception 'Choose the stop.' using errcode = '22023';
  end if;
  select * into r from private.stop_time_writer(p_load);
  if p_arrived is null or p_arrived > now() + interval '5 minutes' or p_arrived < now() - interval '14 days'
     or (p_departed is not null and (p_departed < p_arrived or p_departed > now() + interval '5 minutes')) then
    raise exception 'Arrival is within the last 14 days and departure after it, not in the future.' using errcode = '22023';
  end if;
  if p_location is not null and (p_stop <> 'pickup' or not exists (
       select 1 from public.company_locations c where c.id = p_location and c.company_id = r.company_id)) then
    raise exception 'Location not found.' using errcode = 'P0002';
  end if;
  insert into public.load_stop_times (company_id, load_id, order_id, stop, location_id, arrived_at, departed_at, source)
  values (r.company_id, p_load, r.order_id, p_stop, p_location, p_arrived, p_departed, 'office')
  on conflict (load_id, stop) do update set arrived_at = excluded.arrived_at, departed_at = excluded.departed_at,
    location_id = coalesce(excluded.location_id, public.load_stop_times.location_id), source = 'office', entered_by = auth.uid(), updated_at = now();
  perform private.log_event('wait_time.corrected', 'order', r.order_id,
    format('%s times entered by the office', case p_stop when 'pickup' then 'Pickup' else 'Job site' end),
    jsonb_build_object('load_id', p_load, 'stop', p_stop, 'arrived_at', p_arrived, 'departed_at', p_departed));
end;
$$;

-- Demo sample: finished stops on the demo's recent delivered loads, waits from short to long, one site clearly slow,
-- and a free time of 45 minutes. Fictional; skipped when the demo already has stop times.
create or replace function public.demo_wait_time_samples()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_demo uuid := private.demo_owner_company();
  r record;
  i integer := 0;
  v_slow uuid;
  v_wait integer;
begin
  if v_demo is null then
    raise exception 'Demo samples are only added to a demo company, by its owner.' using errcode = '42501';
  end if;
  if exists (select 1 from public.load_stop_times where company_id = v_demo) then
    return 0;
  end if;
  insert into public.wait_time_settings (company_id, free_minutes) values (v_demo, 45) on conflict (company_id) do nothing;
  select o.site_id into v_slow from public.order_loads l join public.orders o on o.id = l.order_id
   where l.company_id = v_demo and l.load_date < private.company_today(v_demo) and o.site_id is not null
   group by o.site_id order by count(*) desc limit 1;
  for r in
    select l.id, l.order_id, l.starts_at, o.site_id
    from public.order_loads l join public.orders o on o.id = l.order_id
    where l.company_id = v_demo and l.status <> 'canceled' and l.starts_at is not null
      and l.load_date between private.company_today(v_demo) - 14 and private.company_today(v_demo) - 1
    order by l.starts_at limit 24
  loop
    v_wait := case when r.site_id = v_slow or i % 4 = 0 then 55 + (i % 4) * 15 else 12 + (i % 5) * 7 end;
    insert into public.load_stop_times (company_id, load_id, order_id, stop, arrived_at, departed_at, source, entered_by)
    values (v_demo, r.id, r.order_id, 'pickup', r.starts_at, r.starts_at + make_interval(mins => 10 + (i % 3) * 8), 'demo', null),
           (v_demo, r.id, r.order_id, 'site', r.starts_at + interval '50 minutes', r.starts_at + make_interval(mins => 50 + v_wait), 'demo', null)
    on conflict (load_id, stop) do nothing;
    i := i + 1;
  end loop;
  return i;
end;
$$;

revoke all on function public.wait_time_save_settings(integer), public.load_stop_mark(uuid, text, text, uuid),
  public.load_stop_set(uuid, text, timestamptz, timestamptz, uuid), public.demo_wait_time_samples() from public, anon;
grant execute on function public.wait_time_save_settings(integer), public.load_stop_mark(uuid, text, text, uuid),
  public.load_stop_set(uuid, text, timestamptz, timestamptz, uuid), public.demo_wait_time_samples() to authenticated;
revoke all on function private.stop_time_writer(uuid) from public, anon, authenticated;
