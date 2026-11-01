-- =============================================================================
-- GPS and hours of service, provider-neutral (B101, owner decision 2026-10-28: provider not chosen yet).
--
-- Each company chooses its source in Settings → GPS and hours:
--   none    nothing is shown or checked (today's behaviour);
--   manual  dispatch records a truck's last known position and a driver's hours by hand (shown with "entered by");
--   feed    a provider or a middleware posts positions and hours to Taviron's feed endpoint with the company's
--           feed key (only its hash is stored here; the key is shown once).
-- Every position and hours record keeps its source and its time; pages show their age and call data older than the
-- company's limit "stale". Only fresh data from a provider feed may verify a driver's hours for dispatch; hand-entered
-- hours are shown, never treated as verified (src/lib/hos). Nothing is inferred or estimated.
--
-- Reads: dispatch.view or fleet.view. Hand entry: dispatch.edit (positions and hours) or the driver for their own
-- hours. Settings: settings.manage. Feed: only through the server endpoint (service role) with a valid key.
-- Reversible: supabase/rollbacks/20261120004900_telematics.down.sql
-- =============================================================================

create table public.telematics_settings (
  company_id     uuid primary key default private.current_company_id() references public.companies (id),
  source         text not null default 'none' check (source in ('none', 'manual', 'feed')),
  stale_minutes  integer not null default 30 check (stale_minutes between 5 and 1440),
  feed_key_hash  text check (feed_key_hash is null or feed_key_hash ~ '^[0-9a-f]{64}$'),
  feed_key_hint  text not null default '' check (length(feed_key_hint) <= 8),
  feed_key_at    timestamptz,
  last_feed_at   timestamptz,
  updated_by     uuid default auth.uid() references auth.users (id) on delete set null,
  updated_at     timestamptz not null default now()
);
create unique index telematics_settings_feed_key on public.telematics_settings (feed_key_hash) where feed_key_hash is not null;

create table public.vehicle_positions (
  id           bigint generated always as identity primary key,
  company_id   uuid not null references public.companies (id),
  truck_id     uuid not null,
  recorded_at  timestamptz not null,
  latitude     double precision not null check (latitude between -90 and 90),
  longitude    double precision not null check (longitude between -180 and 180),
  speed_mph    numeric(5,1) check (speed_mph is null or speed_mph between 0 and 150),
  heading      smallint check (heading is null or heading between 0 and 359),
  source       text not null check (source in ('manual', 'feed', 'demo')),
  note         text not null default '' check (length(note) <= 200),
  entered_by   uuid default auth.uid() references auth.users (id) on delete set null,
  received_at  timestamptz not null default now(),
  foreign key (company_id, truck_id) references public.trucks (company_id, id) on delete cascade
);
create index vehicle_positions_latest on public.vehicle_positions (company_id, truck_id, recorded_at desc);

create table public.driver_hours (
  id                  bigint generated always as identity primary key,
  company_id          uuid not null references public.companies (id),
  driver_id           uuid not null,
  as_of               timestamptz not null,
  duty_status         text not null check (duty_status in ('off_duty', 'sleeper', 'driving', 'on_duty')),
  drive_minutes_left  integer check (drive_minutes_left is null or drive_minutes_left between 0 and 1440),
  shift_minutes_left  integer check (shift_minutes_left is null or shift_minutes_left between 0 and 1440),
  cycle_minutes_left  integer check (cycle_minutes_left is null or cycle_minutes_left between 0 and 10080),
  source              text not null check (source in ('manual', 'feed', 'demo')),
  entered_by          uuid default auth.uid() references auth.users (id) on delete set null,
  received_at         timestamptz not null default now(),
  foreign key (company_id, driver_id) references public.drivers (company_id, id) on delete cascade
);
create index driver_hours_latest on public.driver_hours (company_id, driver_id, as_of desc);

alter table public.telematics_settings enable row level security;
alter table public.vehicle_positions enable row level security;
alter table public.driver_hours enable row level security;
revoke all on public.telematics_settings, public.vehicle_positions, public.driver_hours from anon, authenticated;
grant select on public.vehicle_positions, public.driver_hours to authenticated;
-- The settings row holds the feed key's hash: read through telematics_status() only, never selected directly.

create policy vehicle_positions_read on public.vehicle_positions for select to authenticated
  using (company_id = (select private.current_company_id())
         and ((select private.has_permission('dispatch.view')) or (select private.has_permission('fleet.view'))));
create policy driver_hours_read on public.driver_hours for select to authenticated
  using (company_id = (select private.current_company_id())
         and ((select private.has_permission('dispatch.view')) or (select private.has_permission('fleet.view'))
              or driver_id = (select private.my_driver_id())));

-- -----------------------------------------------------------------------------
-- Settings
-- -----------------------------------------------------------------------------

-- The company's source and limit, and whether a feed key exists (never the key or its hash).
create or replace function public.telematics_status()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'source', coalesce(s.source, 'none'), 'stale_minutes', coalesce(s.stale_minutes, 30),
    'feed_key_hint', coalesce(s.feed_key_hint, ''), 'feed_key_at', s.feed_key_at, 'last_feed_at', s.last_feed_at)
  from (select private.require_company() as c) x
  left join public.telematics_settings s on s.company_id = x.c;
$$;

create or replace function public.telematics_save_settings(p_source text, p_stale_minutes integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
begin
  perform private.require_permission('settings.manage');
  if p_source not in ('none', 'manual', 'feed') then
    raise exception 'Choose where positions and hours come from.' using errcode = '22023';
  end if;
  if p_stale_minutes is null or p_stale_minutes not between 5 and 1440 then
    raise exception 'Data counts as current for 5 to 1440 minutes.' using errcode = '22023';
  end if;
  insert into public.telematics_settings (company_id, source, stale_minutes) values (v_company, p_source, p_stale_minutes)
  on conflict (company_id) do update set source = excluded.source, stale_minutes = excluded.stale_minutes, updated_by = auth.uid(), updated_at = now();
  perform private.log_event('telematics.settings', 'company', v_company,
    format('GPS and hours: %s (current for %s minutes)', case p_source when 'none' then 'off' when 'manual' then 'entered by hand' else 'provider feed' end, p_stale_minutes),
    jsonb_build_object('source', p_source, 'stale_minutes', p_stale_minutes));
end;
$$;

-- Store a new feed key's hash (the app generates the key and shows it once). Any earlier key stops working.
create or replace function public.telematics_set_feed_key(p_hash text, p_hint text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
begin
  perform private.require_permission('settings.manage');
  if p_hash is null or p_hash !~ '^[0-9a-f]{64}$' or coalesce(length(p_hint), 0) > 8 then
    raise exception 'Invalid feed key.' using errcode = '22023';
  end if;
  insert into public.telematics_settings (company_id, feed_key_hash, feed_key_hint, feed_key_at) values (v_company, p_hash, coalesce(p_hint, ''), now())
  on conflict (company_id) do update set feed_key_hash = excluded.feed_key_hash, feed_key_hint = excluded.feed_key_hint, feed_key_at = now(),
    updated_by = auth.uid(), updated_at = now();
  perform private.log_event('telematics.feed_key', 'company', v_company, 'New GPS and hours feed key created; the previous key no longer works', '{}'::jsonb);
end;
$$;

create or replace function public.telematics_revoke_feed_key()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
begin
  perform private.require_permission('settings.manage');
  update public.telematics_settings set feed_key_hash = null, feed_key_hint = '', feed_key_at = null, updated_by = auth.uid(), updated_at = now()
   where company_id = v_company;
  perform private.log_event('telematics.feed_key', 'company', v_company, 'GPS and hours feed key revoked', '{}'::jsonb);
end;
$$;

-- -----------------------------------------------------------------------------
-- Entered by hand
-- -----------------------------------------------------------------------------
create or replace function public.telematics_record_position(p_truck uuid, p_latitude double precision, p_longitude double precision,
                                                             p_recorded_at timestamptz default null, p_note text default '')
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v_id bigint;
begin
  perform private.require_permission('dispatch.edit');
  if not exists (select 1 from public.trucks t where t.id = p_truck and t.company_id = v_company) then
    raise exception 'Truck not found.' using errcode = 'P0002';
  end if;
  if p_latitude is null or p_longitude is null or p_latitude not between -90 and 90 or p_longitude not between -180 and 180 then
    raise exception 'Enter a valid location.' using errcode = '22023';
  end if;
  if p_recorded_at is not null and (p_recorded_at > now() + interval '5 minutes' or p_recorded_at < now() - interval '7 days') then
    raise exception 'The time is now or up to 7 days ago.' using errcode = '22023';
  end if;
  insert into public.vehicle_positions (company_id, truck_id, recorded_at, latitude, longitude, source, note)
  values (v_company, p_truck, coalesce(p_recorded_at, now()), p_latitude, p_longitude, 'manual', private.clean_text(p_note, 200, 'Note'))
  returning id into v_id;
  return v_id;
end;
$$;

-- A driver's hours entered by hand: by dispatch, or by the driver for themselves. Shown, never treated as verified.
create or replace function public.telematics_record_hours(p_driver uuid, p_duty_status text, p_drive_minutes_left integer,
                                                          p_shift_minutes_left integer default null, p_cycle_minutes_left integer default null)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v_own boolean;
  v_id bigint;
begin
  select coalesce(d.user_id = auth.uid(), false) into v_own from public.drivers d where d.id = p_driver and d.company_id = v_company;
  if not found then
    raise exception 'Driver not found.' using errcode = 'P0002';
  end if;
  if not v_own then
    perform private.require_permission('dispatch.edit');
  end if;
  if p_duty_status not in ('off_duty', 'sleeper', 'driving', 'on_duty') then
    raise exception 'Choose the duty status.' using errcode = '22023';
  end if;
  if (p_drive_minutes_left is not null and p_drive_minutes_left not between 0 and 1440)
     or (p_shift_minutes_left is not null and p_shift_minutes_left not between 0 and 1440)
     or (p_cycle_minutes_left is not null and p_cycle_minutes_left not between 0 and 10080) then
    raise exception 'Hours left must be between 0 and the limit of each clock.' using errcode = '22023';
  end if;
  insert into public.driver_hours (company_id, driver_id, as_of, duty_status, drive_minutes_left, shift_minutes_left, cycle_minutes_left, source)
  values (v_company, p_driver, now(), p_duty_status, p_drive_minutes_left, p_shift_minutes_left, p_cycle_minutes_left, 'manual')
  returning id into v_id;
  return v_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- Provider feed (called by the server endpoint with the service role; never from a browser)
-- -----------------------------------------------------------------------------
-- p_payload: {"positions": [{"truck": "unit number", "latitude": .., "longitude": .., "recorded_at": "...",
--                             "speed_mph": .., "heading": ..}],
--             "hours": [{"driver": "driver id or exact name", "duty_status": "driving", "as_of": "...",
--                        "drive_minutes_left": .., "shift_minutes_left": .., "cycle_minutes_left": ..}]}
-- Rows naming an unknown truck or driver, or with invalid values, are skipped and counted; nothing else is changed.
create or replace function public.telematics_ingest(p_key_hash text, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid;
  v_source text;
  r jsonb;
  v_truck uuid;
  v_driver uuid;
  v_at timestamptz;
  n_pos integer := 0;
  n_hours integer := 0;
  n_skipped integer := 0;
begin
  if p_key_hash is null or p_key_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid feed key.' using errcode = '28000';
  end if;
  select s.company_id, s.source into v_company, v_source from public.telematics_settings s where s.feed_key_hash = p_key_hash;
  if v_company is null then
    raise exception 'Invalid feed key.' using errcode = '28000';
  end if;
  if v_source <> 'feed' then
    raise exception 'The provider feed is turned off for this company.' using errcode = '42501';
  end if;
  if jsonb_typeof(p_payload) <> 'object'
     or coalesce(jsonb_array_length(case when jsonb_typeof(p_payload -> 'positions') = 'array' then p_payload -> 'positions' end), 0)
      + coalesce(jsonb_array_length(case when jsonb_typeof(p_payload -> 'hours') = 'array' then p_payload -> 'hours' end), 0) > 1000 then
    raise exception 'Send at most 1000 rows at a time.' using errcode = '22023';
  end if;

  for r in select * from jsonb_array_elements(case when jsonb_typeof(p_payload -> 'positions') = 'array' then p_payload -> 'positions' else '[]'::jsonb end) loop
    begin
      select t.id into v_truck from public.trucks t where t.company_id = v_company and lower(t.unit_number) = lower(r ->> 'truck') limit 1;
      v_at := coalesce((r ->> 'recorded_at')::timestamptz, now());
      if v_truck is null or v_at > now() + interval '5 minutes' or v_at < now() - interval '7 days' then
        n_skipped := n_skipped + 1;
        continue;
      end if;
      insert into public.vehicle_positions (company_id, truck_id, recorded_at, latitude, longitude, speed_mph, heading, source, entered_by)
      values (v_company, v_truck, v_at, (r ->> 'latitude')::double precision, (r ->> 'longitude')::double precision,
              (r ->> 'speed_mph')::numeric, (r ->> 'heading')::smallint, 'feed', null);
      n_pos := n_pos + 1;
    exception when others then
      n_skipped := n_skipped + 1;
    end;
  end loop;

  for r in select * from jsonb_array_elements(case when jsonb_typeof(p_payload -> 'hours') = 'array' then p_payload -> 'hours' else '[]'::jsonb end) loop
    begin
      select d.id into v_driver from public.drivers d
       where d.company_id = v_company and d.active
         and (d.id::text = r ->> 'driver' or lower(d.name) = lower(r ->> 'driver'))
       order by (d.id::text = r ->> 'driver') desc limit 1;
      v_at := coalesce((r ->> 'as_of')::timestamptz, now());
      if v_driver is null or v_at > now() + interval '5 minutes' or v_at < now() - interval '7 days' then
        n_skipped := n_skipped + 1;
        continue;
      end if;
      insert into public.driver_hours (company_id, driver_id, as_of, duty_status, drive_minutes_left, shift_minutes_left, cycle_minutes_left, source, entered_by)
      values (v_company, v_driver, v_at, r ->> 'duty_status', (r ->> 'drive_minutes_left')::integer, (r ->> 'shift_minutes_left')::integer,
              (r ->> 'cycle_minutes_left')::integer, 'feed', null);
      n_hours := n_hours + 1;
    exception when others then
      n_skipped := n_skipped + 1;
    end;
  end loop;

  update public.telematics_settings set last_feed_at = now() where company_id = v_company;
  return jsonb_build_object('positions', n_pos, 'hours', n_hours, 'skipped', n_skipped);
end;
$$;

-- -----------------------------------------------------------------------------
-- Demo sample: hand-entered positions around the demo yard and a few drivers' hours, so Fleet → Locations and hours
-- show the feature: five current positions, one stale truck, one driver under an hour of drive time. Fictional, source demo.
-- -----------------------------------------------------------------------------
create or replace function public.demo_telematics_samples()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_demo uuid := private.demo_owner_company();
  v_lat double precision;
  v_lng double precision;
  r record;
  i integer := 0;
begin
  if v_demo is null then
    raise exception 'Demo samples are only added to a demo company, by its owner.' using errcode = '42501';
  end if;
  -- Refresh adds a new set only once the last one is past the demo's 30-minute limit (positions are history, not
  -- duplicates), so a demo opened days later still shows current positions.
  if exists (select 1 from public.vehicle_positions where company_id = v_demo and source = 'demo' and received_at > now() - interval '30 minutes') then
    return 0;
  end if;
  select yard_latitude, yard_longitude into v_lat, v_lng from public.company_settings where company_id = v_demo;
  v_lat := coalesce(v_lat, 40.42);
  v_lng := coalesce(v_lng, -86.91);
  insert into public.telematics_settings (company_id, source, stale_minutes) values (v_demo, 'manual', 30)
  on conflict (company_id) do nothing;
  for r in select t.id from public.trucks t where t.company_id = v_demo and t.active order by t.unit_number limit 6 loop
    insert into public.vehicle_positions (company_id, truck_id, recorded_at, latitude, longitude, speed_mph, source, note)
    values (v_demo, r.id, now() - make_interval(mins => case when i = 5 then 185 else 4 + i * 4 end), v_lat + (i % 3 - 1) * 0.06 + i * 0.011, v_lng + (i % 2) * 0.08 - i * 0.017,
            case when i % 3 = 0 then 0 else 38 + i * 4 end, 'demo', '');
    i := i + 1;
  end loop;
  i := 0;
  for r in select d.id from public.drivers d where d.company_id = v_demo and d.active order by d.name limit 5 loop
    insert into public.driver_hours (company_id, driver_id, as_of, duty_status, drive_minutes_left, shift_minutes_left, cycle_minutes_left, source)
    values (v_demo, r.id, now() - make_interval(mins => 6 + i * 7), (array['driving', 'on_duty', 'off_duty', 'driving', 'sleeper'])[i + 1],
            (array[312, 455, 660, 48, 600])[i + 1], (array[420, 610, 840, 95, 840])[i + 1], (array[2950, 3400, 4100, 610, 3900])[i + 1], 'demo');
    i := i + 1;
  end loop;
  return 1;
end;
$$;

revoke all on function public.telematics_status(), public.telematics_save_settings(text, integer), public.telematics_set_feed_key(text, text),
  public.telematics_revoke_feed_key(), public.telematics_record_position(uuid, double precision, double precision, timestamptz, text),
  public.telematics_record_hours(uuid, text, integer, integer, integer), public.demo_telematics_samples() from public, anon;
grant execute on function public.telematics_status(), public.telematics_save_settings(text, integer), public.telematics_set_feed_key(text, text),
  public.telematics_revoke_feed_key(), public.telematics_record_position(uuid, double precision, double precision, timestamptz, text),
  public.telematics_record_hours(uuid, text, integer, integer, integer), public.demo_telematics_samples() to authenticated;
-- The feed is called only by the server endpoint (service role) after it hashes the presented key.
revoke all on function public.telematics_ingest(text, jsonb) from public, anon, authenticated;
grant execute on function public.telematics_ingest(text, jsonb) to service_role;
