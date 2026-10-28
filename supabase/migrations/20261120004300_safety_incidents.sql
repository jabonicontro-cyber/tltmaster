-- =============================================================================
-- Safety incidents (B103, owner 2026-10-28): accidents, injuries, property damage, spills and near misses, with
-- photos, witnesses, an investigation and corrective actions.
--
--   safety_incidents           the report (what happened, when, where, who and what equipment) kept as reported, plus
--                              the investigation (findings and root cause) kept apart from it, and the status:
--                              reported → investigating → actions open → closed.
--   safety_incident_witnesses  people who saw it, with their statement.
--   safety_incident_actions    corrective actions with an owner and a due date; closing needs every one done.
--   safety_incident_photos     photos in the private safety-photos bucket (the server's service role stores and signs).
--   safety_incident_events     who did what and when.
--
-- Permissions: safety.view (owner, office, dispatch) reads the company's incidents; safety.manage (owner, office)
-- investigates, adds actions and closes. A driver reports from the phone (driver.portal) and sees only their own
-- reports' status through my_safety_reports(), never the investigation. Every change goes through a function below.
-- Reversible: supabase/rollbacks/20261120004300_safety_incidents.down.sql
-- =============================================================================

insert into public.permissions (code, category, description) values
  ('safety.view', 'Safety', 'See safety incidents, their investigation and corrective actions'),
  ('safety.manage', 'Safety', 'Investigate safety incidents, add corrective actions and close incidents');
insert into public.role_permission_defaults (role, permission) values
  ('owner', 'safety.view'), ('office', 'safety.view'), ('dispatcher', 'safety.view'),
  ('owner', 'safety.manage'), ('office', 'safety.manage');
insert into public.role_permissions (company_id, role, permission)
select c.id, d.role, d.permission from public.companies c cross join public.role_permission_defaults d
where d.permission in ('safety.view', 'safety.manage')
on conflict do nothing;

create table public.safety_incidents (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references public.companies (id),
  number           text not null,
  kind             text not null check (kind in ('accident', 'injury', 'property_damage', 'spill', 'near_miss', 'other')),
  severity         text not null default 'minor' check (severity in ('minor', 'moderate', 'serious')),
  occurred_at      timestamptz not null,
  location         text not null default '' check (length(location) <= 300),
  description      text not null check (length(trim(description)) between 1 and 4000),
  injury           boolean not null default false,
  vehicle_damage   boolean not null default false,
  truck_id         uuid,
  trailer_id       uuid,
  driver_id        uuid,
  order_id         uuid,
  reported_by      uuid references auth.users (id) on delete set null,
  reported_at      timestamptz not null default now(),
  status           text not null default 'reported' check (status in ('reported', 'investigating', 'actions_open', 'closed')),
  findings         text not null default '' check (length(findings) <= 8000),
  root_cause       text not null default '' check (length(root_cause) <= 2000),
  closed_at        timestamptz,
  closed_by        uuid references auth.users (id) on delete set null,
  closed_note      text not null default '',
  updated_at       timestamptz not null default now(),
  unique (company_id, id),
  unique (company_id, number),
  foreign key (company_id, truck_id) references public.trucks (company_id, id) on delete set null (truck_id),
  foreign key (company_id, trailer_id) references public.trailers (company_id, id) on delete set null (trailer_id),
  foreign key (company_id, driver_id) references public.drivers (company_id, id) on delete set null (driver_id),
  foreign key (company_id, order_id) references public.orders (company_id, id) on delete set null (order_id),
  check ((status = 'closed') = (closed_at is not null))
);
create index safety_incidents_company_idx on public.safety_incidents (company_id, status, occurred_at desc);

create table public.safety_incident_witnesses (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies (id),
  incident_id  uuid not null,
  name         text not null check (length(trim(name)) between 1 and 120),
  phone        text not null default '' check (length(phone) <= 40),
  statement    text not null default '' check (length(statement) <= 4000),
  added_by     uuid references auth.users (id) on delete set null,
  added_at     timestamptz not null default now(),
  foreign key (company_id, incident_id) references public.safety_incidents (company_id, id) on delete cascade
);
create index safety_incident_witnesses_idx on public.safety_incident_witnesses (incident_id);

create table public.safety_incident_actions (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies (id),
  incident_id  uuid not null,
  description  text not null check (length(trim(description)) between 1 and 1000),
  assigned_to  uuid references auth.users (id) on delete set null,
  due_on       date,
  status       text not null default 'open' check (status in ('open', 'done')),
  done_at      timestamptz,
  done_by      uuid references auth.users (id) on delete set null,
  done_note    text not null default '' check (length(done_note) <= 2000),
  created_by   uuid references auth.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  foreign key (company_id, incident_id) references public.safety_incidents (company_id, id) on delete cascade,
  check ((status = 'done') = (done_at is not null))
);
create index safety_incident_actions_idx on public.safety_incident_actions (company_id, status, due_on);

create table public.safety_incident_photos (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies (id),
  incident_id  uuid not null,
  object_path  text not null unique check (object_path ~ '^[0-9a-f-]{36}/safety/[0-9a-f-]{36}\.(jpg|png|webp)$'),
  mime_type    text not null check (mime_type in ('image/jpeg', 'image/png', 'image/webp')),
  size_bytes   integer not null check (size_bytes between 1 and 5242880),
  uploaded_by  uuid references auth.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  foreign key (company_id, incident_id) references public.safety_incidents (company_id, id) on delete cascade
);
create index safety_incident_photos_idx on public.safety_incident_photos (incident_id);

create table public.safety_incident_events (
  id           bigint generated always as identity primary key,
  company_id   uuid not null references public.companies (id),
  incident_id  uuid not null,
  at           timestamptz not null default now(),
  actor        uuid references auth.users (id) on delete set null,
  action       text not null,
  note         text not null default '',
  foreign key (company_id, incident_id) references public.safety_incidents (company_id, id) on delete cascade
);
create index safety_incident_events_idx on public.safety_incident_events (incident_id, at);

alter table public.safety_incidents enable row level security;
alter table public.safety_incident_witnesses enable row level security;
alter table public.safety_incident_actions enable row level security;
alter table public.safety_incident_photos enable row level security;
alter table public.safety_incident_events enable row level security;

-- Reads: people with safety.view, in their own company. Drivers read their own reports through my_safety_reports().
create policy safety_incidents_read on public.safety_incidents for select to authenticated
  using (company_id = (select private.current_company_id()) and (select private.has_permission('safety.view')));
create policy safety_incident_witnesses_read on public.safety_incident_witnesses for select to authenticated
  using (company_id = (select private.current_company_id()) and (select private.has_permission('safety.view')));
create policy safety_incident_actions_read on public.safety_incident_actions for select to authenticated
  using (company_id = (select private.current_company_id())
         and ((select private.has_permission('safety.view')) or assigned_to = (select auth.uid())));
create policy safety_incident_photos_read on public.safety_incident_photos for select to authenticated
  using (company_id = (select private.current_company_id()) and (select private.has_permission('safety.view')));
create policy safety_incident_events_read on public.safety_incident_events for select to authenticated
  using (company_id = (select private.current_company_id()) and (select private.has_permission('safety.view')));
revoke all on public.safety_incidents, public.safety_incident_witnesses, public.safety_incident_actions,
  public.safety_incident_photos, public.safety_incident_events from anon;
grant select on public.safety_incidents, public.safety_incident_witnesses, public.safety_incident_actions,
  public.safety_incident_photos, public.safety_incident_events to authenticated;

-- An incident of the caller's company, locked, that the caller may manage (internal).
create or replace function private.safety_incident_for_manage(p_id uuid)
returns public.safety_incidents
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.safety_incidents%rowtype;
begin
  perform private.require_permission('safety.manage');
  select * into v from public.safety_incidents where id = p_id and company_id = private.require_company() for update;
  if not found then
    raise exception 'Incident not found.' using errcode = 'P0002';
  end if;
  return v;
end;
$$;
revoke all on function private.safety_incident_for_manage(uuid) from public, anon, authenticated;

create or replace function private.safety_log(p_company uuid, p_incident uuid, p_action text, p_note text default '')
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.safety_incident_events (company_id, incident_id, actor, action, note)
  values (p_company, p_incident, auth.uid(), p_action, coalesce(p_note, ''));
$$;
revoke all on function private.safety_log(uuid, uuid, text, text) from public, anon, authenticated;

-- Report an incident. Office staff (safety.manage) report for anyone; a driver (driver.portal) reports as themselves:
-- the driver is always their own record, whatever the form sent. Returns the new id and number ("INC-0001").
create or replace function public.safety_report(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v_manage boolean := private.has_permission('safety.manage');
  v_driver uuid;
  v_kind text := coalesce(p ->> 'kind', '');
  v_severity text := coalesce(nullif(p ->> 'severity', ''), 'minor');
  v_at timestamptz;
  v_number text;
  v_id uuid;
begin
  if not v_manage then
    if not private.has_permission('driver.portal') then
      raise exception 'You do not have permission to report safety incidents.' using errcode = '42501';
    end if;
    v_driver := private.my_driver_id();
    if v_driver is null then
      raise exception 'Your sign-in is not linked to a driver record. Ask the office to report it.' using errcode = '42501';
    end if;
  else
    v_driver := nullif(p ->> 'driver_id', '')::uuid;
  end if;
  if v_kind not in ('accident', 'injury', 'property_damage', 'spill', 'near_miss', 'other') then
    raise exception 'Choose what happened.' using errcode = '22023';
  end if;
  if v_severity not in ('minor', 'moderate', 'serious') then
    raise exception 'Choose how serious it was.' using errcode = '22023';
  end if;
  begin
    v_at := (p ->> 'occurred_at')::timestamptz;
  exception when others then
    v_at := null;
  end;
  if v_at is null then
    raise exception 'Enter when it happened.' using errcode = '22023';
  end if;
  if v_at > now() + interval '10 minutes' then
    raise exception 'The time cannot be in the future.' using errcode = '22023';
  end if;
  if length(trim(coalesce(p ->> 'description', ''))) = 0 then
    raise exception 'Describe what happened.' using errcode = '22023';
  end if;

  -- One number per company, in order: INC-0001, INC-0002…
  perform pg_advisory_xact_lock(hashtext(v_company::text || ':safety_incident'));
  select 'INC-' || lpad((coalesce(max(substring(number from 5)::integer), 0) + 1)::text, 4, '0') into v_number
    from public.safety_incidents where company_id = v_company and number ~ '^INC-[0-9]+$';

  insert into public.safety_incidents (company_id, number, kind, severity, occurred_at, location, description, injury,
                                       vehicle_damage, truck_id, trailer_id, driver_id, order_id, reported_by)
  values (v_company, v_number, v_kind, v_severity, v_at, left(trim(coalesce(p ->> 'location', '')), 300),
          trim(p ->> 'description'), coalesce((p ->> 'injury')::boolean, false), coalesce((p ->> 'vehicle_damage')::boolean, false),
          nullif(p ->> 'truck_id', '')::uuid, nullif(p ->> 'trailer_id', '')::uuid, v_driver, nullif(p ->> 'order_id', '')::uuid,
          auth.uid())
  returning id into v_id;
  perform private.safety_log(v_company, v_id, 'reported');
  return jsonb_build_object('id', v_id, 'number', v_number);
exception
  when foreign_key_violation then
    raise exception 'The truck, trailer, driver or order was not found.' using errcode = '22023';
end;
$$;

-- The investigation: classification, findings and root cause, and moving to "investigating" (safety.manage).
create or replace function public.safety_investigate(p_id uuid, p jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.safety_incidents%rowtype := private.safety_incident_for_manage(p_id);
  v_kind text := coalesce(nullif(p ->> 'kind', ''), v.kind);
  v_severity text := coalesce(nullif(p ->> 'severity', ''), v.severity);
begin
  if v.status = 'closed' then
    raise exception 'This incident is closed.' using errcode = '22023';
  end if;
  if v_kind not in ('accident', 'injury', 'property_damage', 'spill', 'near_miss', 'other')
     or v_severity not in ('minor', 'moderate', 'serious') then
    raise exception 'Choose what happened and how serious it was.' using errcode = '22023';
  end if;
  update public.safety_incidents
     set kind = v_kind, severity = v_severity,
         findings = left(coalesce(p ->> 'findings', findings), 8000),
         root_cause = left(coalesce(p ->> 'root_cause', root_cause), 2000),
         status = case when status = 'reported' then 'investigating' else status end,
         updated_at = now()
   where id = v.id;
  perform private.safety_log(v.company_id, v.id, 'investigation saved');
end;
$$;

-- A witness and their statement (safety.manage).
create or replace function public.safety_add_witness(p_id uuid, p_name text, p_phone text, p_statement text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.safety_incidents%rowtype := private.safety_incident_for_manage(p_id);
begin
  if length(trim(coalesce(p_name, ''))) = 0 then
    raise exception 'Enter the witness''s name.' using errcode = '22023';
  end if;
  insert into public.safety_incident_witnesses (company_id, incident_id, name, phone, statement, added_by)
  values (v.company_id, v.id, left(trim(p_name), 120), left(trim(coalesce(p_phone, '')), 40), left(trim(coalesce(p_statement, '')), 4000), auth.uid());
  perform private.safety_log(v.company_id, v.id, 'witness added', left(trim(p_name), 120));
end;
$$;

-- A corrective action with an owner (a member of the company) and a due date (safety.manage).
create or replace function public.safety_add_action(p_id uuid, p_description text, p_assigned_to uuid, p_due_on date)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.safety_incidents%rowtype := private.safety_incident_for_manage(p_id);
  v_action uuid;
begin
  if v.status = 'closed' then
    raise exception 'This incident is closed.' using errcode = '22023';
  end if;
  if length(trim(coalesce(p_description, ''))) = 0 then
    raise exception 'Describe the action.' using errcode = '22023';
  end if;
  if p_assigned_to is not null and not exists (
    select 1 from public.company_memberships m where m.company_id = v.company_id and m.user_id = p_assigned_to and m.active) then
    raise exception 'Choose someone in your company.' using errcode = '22023';
  end if;
  insert into public.safety_incident_actions (company_id, incident_id, description, assigned_to, due_on, created_by)
  values (v.company_id, v.id, left(trim(p_description), 1000), p_assigned_to, p_due_on, auth.uid())
  returning id into v_action;
  update public.safety_incidents set status = 'actions_open', updated_at = now() where id = v.id;
  perform private.safety_log(v.company_id, v.id, 'action added', left(trim(p_description), 200));
  return v_action;
end;
$$;

-- Mark an action done: the person it was given to, or safety.manage.
create or replace function public.safety_complete_action(p_action uuid, p_note text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  a public.safety_incident_actions%rowtype;
begin
  select * into a from public.safety_incident_actions
   where id = p_action and company_id = private.require_company() for update;
  if not found then
    raise exception 'Action not found.' using errcode = 'P0002';
  end if;
  if not (private.has_permission('safety.manage') or a.assigned_to = auth.uid()) then
    raise exception 'Only the person it was given to, or someone who manages safety, can complete this action.' using errcode = '42501';
  end if;
  if a.status = 'done' then
    return;
  end if;
  update public.safety_incident_actions
     set status = 'done', done_at = now(), done_by = auth.uid(), done_note = left(trim(coalesce(p_note, '')), 2000)
   where id = a.id;
  perform private.safety_log(a.company_id, a.incident_id, 'action done', left(a.description, 200));
end;
$$;

-- Close: findings recorded and every corrective action done (safety.manage).
create or replace function public.safety_close(p_id uuid, p_note text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.safety_incidents%rowtype := private.safety_incident_for_manage(p_id);
begin
  if v.status = 'closed' then
    return;
  end if;
  if length(trim(v.findings)) = 0 then
    raise exception 'Record the findings before closing.' using errcode = '22023';
  end if;
  if exists (select 1 from public.safety_incident_actions where incident_id = v.id and status = 'open') then
    raise exception 'Every corrective action must be done before closing.' using errcode = '22023';
  end if;
  update public.safety_incidents
     set status = 'closed', closed_at = now(), closed_by = auth.uid(), closed_note = left(trim(coalesce(p_note, '')), 2000), updated_at = now()
   where id = v.id;
  perform private.safety_log(v.company_id, v.id, 'closed', left(trim(coalesce(p_note, '')), 200));
end;
$$;

-- Reserve a path for one photo (at most 8 per incident): the reporter while it is open, or safety.manage.
create or replace function public.safety_photo_begin(p_id uuid, p_mime text, p_size integer)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.safety_incidents%rowtype;
  v_path text;
begin
  select * into v from public.safety_incidents where id = p_id and company_id = private.require_company() for update;
  if not found or not (private.has_permission('safety.manage') or (v.reported_by = auth.uid() and v.status <> 'closed')) then
    raise exception 'Incident not found.' using errcode = 'P0002';
  end if;
  if p_mime not in ('image/jpeg', 'image/png', 'image/webp') or p_size is null or p_size < 1 or p_size > 5242880 then
    raise exception 'Photos must be JPEG, PNG or WebP and at most 5 MB.' using errcode = '22023';
  end if;
  if (select count(*) from public.safety_incident_photos where incident_id = v.id) >= 8 then
    raise exception 'At most 8 photos per incident.' using errcode = '22023';
  end if;
  v_path := format('%s/safety/%s.%s', v.company_id, gen_random_uuid(), case p_mime when 'image/png' then 'png' when 'image/webp' then 'webp' else 'jpg' end);
  insert into public.safety_incident_photos (company_id, incident_id, object_path, mime_type, size_bytes, uploaded_by)
  values (v.company_id, v.id, v_path, p_mime, p_size, auth.uid());
  perform private.safety_log(v.company_id, v.id, 'photo added');
  return v_path;
end;
$$;

-- The file path of a photo for people who may see it (safety.view, or the reporter); the app signs a short link.
create or replace function public.safety_photo_path(p_photo uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select p.object_path from public.safety_incident_photos p
    join public.safety_incidents i on i.id = p.incident_id
   where p.id = p_photo and p.company_id = private.current_company_id()
     and (private.has_permission('safety.view') or i.reported_by = auth.uid());
$$;

-- A reporter's own incidents with their status (never the investigation), for the driver's phone.
create or replace function public.my_safety_reports()
returns table (id uuid, number text, kind text, severity text, occurred_at timestamptz, status text, photos integer)
language sql
stable
security definer
set search_path = ''
as $$
  select i.id, i.number, i.kind, i.severity, i.occurred_at, i.status,
         (select count(*)::integer from public.safety_incident_photos p where p.incident_id = i.id)
    from public.safety_incidents i
   where i.company_id = private.current_company_id() and i.reported_by = auth.uid()
   order by i.occurred_at desc
   limit 20;
$$;

-- Demo samples: one closed near miss with findings and a done action, one open accident under investigation with an
-- open action, and one new report from a driver (demo owner only; once).
create or replace function public.demo_safety_samples()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_demo uuid := private.demo_owner_company();
  v_trucks uuid[];
  v_drivers uuid[];
  v_closed uuid;
  v_open uuid;
  v_new uuid;
  v_today date;
  v_tz text;
begin
  if v_demo is null then
    raise exception 'Demo samples are only added to a demo company, by its owner.' using errcode = '42501';
  end if;
  if exists (select 1 from public.safety_incidents where company_id = v_demo) then
    return 0;
  end if;
  v_today := private.company_today(v_demo);
  v_tz := private.business_timezone(v_demo);
  select array_agg(id order by unit_number) into v_trucks from public.trucks where company_id = v_demo and active;
  select array_agg(id order by name) into v_drivers from public.drivers where company_id = v_demo and active;

  insert into public.safety_incidents (company_id, number, kind, severity, occurred_at, location, description, injury, vehicle_damage,
                                       truck_id, driver_id, reported_by, reported_at, status, findings, root_cause, closed_at, closed_by, closed_note)
  values (v_demo, 'INC-0001', 'near_miss', 'moderate', ((v_today - 12) + interval '14 hours 20 minutes') at time zone v_tz,
          'Plant 2 loading lane (demo)', 'Loader backed toward the truck while the driver was walking to the cab. No contact. (Sample incident in a demo company.)',
          false, false, v_trucks[1], v_drivers[1], auth.uid(), ((v_today - 12) + interval '15 hours') at time zone v_tz, 'closed',
          'The walking path crosses the loader''s turning area; no spotter at shift change. (Sample findings.)',
          'No marked walkway in the loading lane.', ((v_today - 5) + interval '10 hours') at time zone v_tz, auth.uid(), 'Walkway painted and spotter rule added. (Sample.)')
  returning id into v_closed;
  insert into public.safety_incident_actions (company_id, incident_id, description, due_on, status, done_at, done_by, done_note, created_by)
  values (v_demo, v_closed, 'Paint a walkway and stop line in the loading lane (sample)', v_today - 6, 'done',
          ((v_today - 6) + interval '11 hours') at time zone v_tz, auth.uid(), 'Painted by the yard crew. (Sample.)', auth.uid());
  insert into public.safety_incident_witnesses (company_id, incident_id, name, phone, statement, added_by)
  values (v_demo, v_closed, 'Loader operator (demo)', '', 'Did not see the driver in the mirror. (Sample statement.)', auth.uid());

  insert into public.safety_incidents (company_id, number, kind, severity, occurred_at, location, description, injury, vehicle_damage,
                                       truck_id, driver_id, reported_by, reported_at, status, findings)
  values (v_demo, 'INC-0002', 'accident', 'moderate', ((v_today - 2) + interval '9 hours 5 minutes') at time zone v_tz,
          'Customer site gate, County Road 400 (demo)', 'Mirror struck the gate post while turning in. Mirror broken, no one hurt. (Sample incident in a demo company.)',
          false, true, v_trucks[2], v_drivers[2], auth.uid(), ((v_today - 2) + interval '9 hours 40 minutes') at time zone v_tz, 'actions_open',
          'Gate opening is narrow for a tractor with an end-dump; the driver had not been to this site before. (Sample findings.)')
  returning id into v_open;
  insert into public.safety_incident_actions (company_id, incident_id, description, due_on, created_by)
  values (v_demo, v_open, 'Add the narrow gate to the site directions and brief drivers (sample)', v_today + 3, auth.uid());

  insert into public.safety_incidents (company_id, number, kind, severity, occurred_at, location, description, driver_id, truck_id, reported_by)
  values (v_demo, 'INC-0003', 'spill', 'minor', ((v_today - 1) + interval '15 hours 30 minutes') at time zone v_tz, 'Yard fuel island (demo)',
          'About a gallon of diesel spilled while fueling; absorbent used. (Sample report in a demo company.)', v_drivers[3], v_trucks[3], auth.uid())
  returning id into v_new;

  insert into public.safety_incident_events (company_id, incident_id, actor, action, at)
  select v_demo, i.id, auth.uid(), 'reported', i.reported_at from public.safety_incidents i where i.company_id = v_demo;
  return 3;
end;
$$;

revoke all on function public.safety_report(jsonb), public.safety_investigate(uuid, jsonb), public.safety_add_witness(uuid, text, text, text),
  public.safety_add_action(uuid, text, uuid, date), public.safety_complete_action(uuid, text), public.safety_close(uuid, text),
  public.safety_photo_begin(uuid, text, integer), public.safety_photo_path(uuid), public.my_safety_reports(), public.demo_safety_samples() from public, anon;
grant execute on function public.safety_report(jsonb), public.safety_investigate(uuid, jsonb), public.safety_add_witness(uuid, text, text, text),
  public.safety_add_action(uuid, text, uuid, date), public.safety_complete_action(uuid, text), public.safety_close(uuid, text),
  public.safety_photo_begin(uuid, text, integer), public.safety_photo_path(uuid), public.my_safety_reports(), public.demo_safety_samples() to authenticated;

-- The private bucket (no policies: only the server's service role reads and writes it).
do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('safety-photos', 'safety-photos', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
    on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
  end if;
end;
$$;
