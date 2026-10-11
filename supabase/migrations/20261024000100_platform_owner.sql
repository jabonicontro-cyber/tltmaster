-- =============================================================================
-- N13: platform owner (Taviron team), public website leads, live demo company,
-- team-led company onboarding imports.
--
-- * The platform-owner role is separate from every company role. It lives in
--   private.platform_admins, is granted only by an operator with the service
--   role (scripts/platform-admin.mjs), and is checked inside every platform_*
--   function. No public route or app user can grant it.
-- * Leads from the public website are written only by the server (service
--   role), with a per-address rate limit and duplicate merging. Only platform
--   admins can read or work them.
-- * The live demo is an ordinary, isolated company flagged is_demo, filled
--   with fictional data. Starting a new demo deactivates the previous demo
--   company (nothing is deleted).
-- * Onboarding imports are staged (validated, duplicates flagged), reviewed,
--   then approved; only approval creates records. Reverting removes exactly
--   the records the batch created and keeps (deactivates) any that have since
--   been changed or used.
-- Every sensitive platform action is written to private.platform_audit.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Platform admins and audit
-- -----------------------------------------------------------------------------
create table private.platform_admins (
  user_id     uuid primary key references auth.users (id) on delete cascade,
  note        text not null default '',
  granted_at  timestamptz not null default now(),
  revoked_at  timestamptz,
  revoke_note text not null default ''
);

create table private.platform_audit (
  id          bigint generated always as identity primary key,
  actor_id    uuid,
  action      text not null,
  target_type text not null default '',
  target_id   text not null default '',
  summary     text not null default '',
  detail      jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default clock_timestamp()
);
create index platform_audit_time on private.platform_audit (occurred_at desc);

create or replace function private.platform_audit_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'Platform audit entries cannot be changed or deleted.' using errcode = '42501';
end;
$$;
create trigger platform_audit_append_only before update or delete on private.platform_audit
  for each row execute function private.platform_audit_append_only();

revoke all on private.platform_admins, private.platform_audit from public, anon, authenticated;

create or replace function private.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null
     and exists (select 1 from private.platform_admins a where a.user_id = auth.uid() and a.revoked_at is null)
$$;

-- Platform functions answer "not found" style errors to everyone else, so they
-- reveal nothing about what exists.
create or replace function private.require_platform_admin()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.is_platform_admin() then
    raise exception 'Not available.' using errcode = '42501';
  end if;
  return auth.uid();
end;
$$;

create or replace function private.platform_log(p_action text, p_target_type text, p_target_id text, p_summary text, p_detail jsonb default '{}'::jsonb)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into private.platform_audit (actor_id, action, target_type, target_id, summary, detail)
  values (auth.uid(), p_action, coalesce(p_target_type, ''), coalesce(p_target_id, ''), coalesce(p_summary, ''), coalesce(p_detail, '{}'::jsonb));
$$;

-- Am I a platform admin? (Any signed-in user may ask about themselves.)
create or replace function public.platform_whoami()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.is_platform_admin()
$$;

-- Operator (service role) only: grant / revoke / list.
create or replace function public.platform_admin_grant(p_email text, p_note text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid;
begin
  select id into v_user from auth.users where lower(email) = lower(trim(p_email));
  if v_user is null then
    return jsonb_build_object('ok', false, 'reason', 'no_account');
  end if;
  insert into private.platform_admins (user_id, note) values (v_user, coalesce(p_note, ''))
  on conflict (user_id) do update set revoked_at = null, revoke_note = '', note = excluded.note, granted_at = now();
  insert into private.platform_audit (actor_id, action, target_type, target_id, summary, detail)
  values (null, 'admin_granted', 'user', v_user::text, 'Platform admin granted by operator', jsonb_build_object('note', coalesce(p_note, '')));
  return jsonb_build_object('ok', true, 'user_id', v_user);
end;
$$;

create or replace function public.platform_admin_revoke(p_email text, p_note text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid;
begin
  select id into v_user from auth.users where lower(email) = lower(trim(p_email));
  update private.platform_admins set revoked_at = now(), revoke_note = coalesce(p_note, '')
  where user_id = v_user and revoked_at is null;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_admin');
  end if;
  insert into private.platform_audit (actor_id, action, target_type, target_id, summary, detail)
  values (null, 'admin_revoked', 'user', v_user::text, 'Platform admin revoked by operator', jsonb_build_object('note', coalesce(p_note, '')));
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.platform_admin_list()
returns table (email text, full_name text, granted_at timestamptz, revoked_at timestamptz, note text)
language sql
stable
security definer
set search_path = ''
as $$
  select p.email, p.full_name, a.granted_at, a.revoked_at, a.note
  from private.platform_admins a join public.profiles p on p.id = a.user_id
  order by a.revoked_at nulls first, a.granted_at
$$;

-- For platform admins: who else is on the team (lead owners).
create or replace function public.platform_team()
returns table (user_id uuid, full_name text, email text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_platform_admin();
  return query
    select a.user_id, p.full_name, p.email
    from private.platform_admins a join public.profiles p on p.id = a.user_id
    where a.revoked_at is null
    order by p.full_name, p.email;
end;
$$;

create or replace function public.platform_audit_recent(p_limit integer)
returns table (occurred_at timestamptz, actor text, action text, target_type text, target_id text, summary text, detail jsonb)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_platform_admin();
  return query
    select l.occurred_at, coalesce(nullif(p.full_name, ''), p.email, 'Operator'), l.action, l.target_type, l.target_id, l.summary, l.detail
    from private.platform_audit l left join public.profiles p on p.id = l.actor_id
    order by l.occurred_at desc, l.id desc
    limit least(greatest(coalesce(p_limit, 50), 1), 500);
end;
$$;

-- -----------------------------------------------------------------------------
-- 2. Leads from the public website
-- -----------------------------------------------------------------------------
create table private.leads (
  id                uuid primary key default gen_random_uuid(),
  kind              text not null check (kind in ('demo', 'contact')),
  status            text not null default 'new'
                    check (status in ('new', 'contacted', 'demo_scheduled', 'qualified', 'onboarding', 'won', 'lost', 'spam')),
  name              text not null check (length(name) between 1 and 120),
  email             text not null check (length(email) between 3 and 254),
  company_name      text not null default '' check (length(company_name) <= 160),
  phone             text not null default '' check (length(phone) <= 40),
  role_title        text not null default '' check (length(role_title) <= 120),
  fleet_size        text not null default '' check (length(fleet_size) <= 40),
  message           text not null default '' check (length(message) <= 4000),
  source_path       text not null default '' check (length(source_path) <= 200),
  owner_id          uuid references auth.users (id) on delete set null,
  follow_up_on      date,
  submission_count  integer not null default 1,
  last_submitted_at timestamptz not null default now(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index leads_email on private.leads (lower(email));
create index leads_status on private.leads (status, created_at desc);

create table private.lead_events (
  id          bigint generated always as identity primary key,
  lead_id     uuid not null references private.leads (id) on delete cascade,
  actor_id    uuid,
  action      text not null check (action in ('submitted', 'resubmitted', 'status_changed', 'owner_changed', 'follow_up_changed', 'note_added', 'company_created')),
  detail      jsonb not null default '{}'::jsonb,
  note        text not null default '' check (length(note) <= 4000),
  occurred_at timestamptz not null default clock_timestamp()
);
create index lead_events_lead on private.lead_events (lead_id, occurred_at);

-- One row per submission attempt, keyed by a hash of the address (never the address).
create table private.lead_attempts (
  id         bigint generated always as identity primary key,
  ip_hash    text not null,
  created_at timestamptz not null default now()
);
create index lead_attempts_lookup on private.lead_attempts (ip_hash, created_at);

revoke all on private.leads, private.lead_events, private.lead_attempts from public, anon, authenticated;

-- Server only (service role). Validates again, rate limits (5 per address per
-- 15 minutes, 20 per day), and merges a repeat submission from the same email
-- into the open lead. The answer never says whether a lead already existed.
create or replace function public.lead_submit(p_lead jsonb, p_ip_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_kind    text := p_lead ->> 'kind';
  v_name    text := trim(coalesce(p_lead ->> 'name', ''));
  v_email   text := lower(trim(coalesce(p_lead ->> 'email', '')));
  v_message text := trim(coalesce(p_lead ->> 'message', ''));
  v_id      uuid;
  v_recent  integer;
  v_day     integer;
begin
  if coalesce(p_ip_hash, '') = '' then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;
  select count(*) filter (where created_at > now() - interval '15 minutes'), count(*)
    into v_recent, v_day
  from private.lead_attempts where ip_hash = p_ip_hash and created_at > now() - interval '1 day';
  if v_recent >= 5 or v_day >= 20 then
    return jsonb_build_object('ok', false, 'reason', 'rate_limited');
  end if;
  insert into private.lead_attempts (ip_hash) values (p_ip_hash);

  if v_kind not in ('demo', 'contact') or v_name = '' or length(v_name) > 120
     or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or length(v_email) > 254 or length(v_message) > 4000 then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;

  select id into v_id from private.leads
  where lower(email) = v_email and status not in ('won', 'lost', 'spam') and created_at > now() - interval '90 days'
  order by created_at desc limit 1
  for update;

  if v_id is not null then
    update private.leads set
      submission_count = submission_count + 1,
      last_submitted_at = now(),
      updated_at = now(),
      company_name = coalesce(nullif(left(trim(coalesce(p_lead ->> 'company_name', '')), 160), ''), company_name),
      phone = coalesce(nullif(left(trim(coalesce(p_lead ->> 'phone', '')), 40), ''), phone)
    where id = v_id;
    insert into private.lead_events (lead_id, action, detail, note)
    values (v_id, 'resubmitted', jsonb_build_object('kind', v_kind, 'source', left(coalesce(p_lead ->> 'source_path', ''), 200)), left(v_message, 4000));
    return jsonb_build_object('ok', true);
  end if;

  insert into private.leads (kind, name, email, company_name, phone, role_title, fleet_size, message, source_path)
  values (v_kind, v_name, v_email,
          left(trim(coalesce(p_lead ->> 'company_name', '')), 160),
          left(trim(coalesce(p_lead ->> 'phone', '')), 40),
          left(trim(coalesce(p_lead ->> 'role_title', '')), 120),
          left(trim(coalesce(p_lead ->> 'fleet_size', '')), 40),
          v_message,
          left(coalesce(p_lead ->> 'source_path', ''), 200))
  returning id into v_id;
  insert into private.lead_events (lead_id, action, detail) values (v_id, 'submitted', jsonb_build_object('kind', v_kind));
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.platform_leads(p_search text, p_status text, p_due_only boolean)
returns table (id uuid, kind text, status text, name text, email text, company_name text, fleet_size text,
               owner_id uuid, owner_name text, follow_up_on date, submission_count integer,
               last_submitted_at timestamptz, created_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_q text := nullif(trim(coalesce(p_search, '')), '');
begin
  perform private.require_platform_admin();
  return query
    select l.id, l.kind, l.status, l.name, l.email, l.company_name, l.fleet_size, l.owner_id,
           coalesce(nullif(p.full_name, ''), p.email), l.follow_up_on, l.submission_count, l.last_submitted_at, l.created_at
    from private.leads l left join public.profiles p on p.id = l.owner_id
    where (nullif(p_status, '') is null and l.status <> 'spam' or l.status = p_status)
      and (not coalesce(p_due_only, false) or (l.follow_up_on is not null and l.follow_up_on <= current_date and l.status not in ('won', 'lost', 'spam')))
      and (v_q is null
           or l.name ilike '%' || v_q || '%' or l.email ilike '%' || v_q || '%'
           or l.company_name ilike '%' || v_q || '%' or l.message ilike '%' || v_q || '%')
    order by (l.status = 'new') desc, l.follow_up_on nulls last, l.last_submitted_at desc
    limit 500;
end;
$$;

create or replace function public.platform_lead(p_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v jsonb;
begin
  perform private.require_platform_admin();
  select to_jsonb(l) || jsonb_build_object('owner_name', coalesce(nullif(p.full_name, ''), p.email)) into v
  from private.leads l left join public.profiles p on p.id = l.owner_id where l.id = p_id;
  if v is null then return null; end if;
  return v || jsonb_build_object('events', coalesce((
    select jsonb_agg(jsonb_build_object('action', e.action, 'detail', e.detail, 'note', e.note, 'occurred_at', e.occurred_at,
                                        'actor', coalesce(nullif(p.full_name, ''), p.email, 'Website')) order by e.occurred_at, e.id)
    from private.lead_events e left join public.profiles p on p.id = e.actor_id where e.lead_id = p_id), '[]'::jsonb));
end;
$$;

-- Change status, owner and follow-up date; each change is recorded.
create or replace function public.platform_lead_update(p_id uuid, p_status text, p_owner uuid, p_follow_up date)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.require_platform_admin();
  v    private.leads%rowtype;
begin
  select * into v from private.leads where id = p_id for update;
  if not found then raise exception 'Lead not found.' using errcode = 'P0002'; end if;
  if p_status not in ('new', 'contacted', 'demo_scheduled', 'qualified', 'onboarding', 'won', 'lost', 'spam') then
    raise exception 'Unknown status.' using errcode = '22023';
  end if;
  if p_owner is not null and not exists (select 1 from private.platform_admins a where a.user_id = p_owner and a.revoked_at is null) then
    raise exception 'The owner must be a member of the platform team.' using errcode = '22023';
  end if;
  if p_status <> v.status then
    insert into private.lead_events (lead_id, actor_id, action, detail) values (p_id, v_me, 'status_changed', jsonb_build_object('from', v.status, 'to', p_status));
  end if;
  if p_owner is distinct from v.owner_id then
    insert into private.lead_events (lead_id, actor_id, action, detail) values (p_id, v_me, 'owner_changed', jsonb_build_object('from', v.owner_id, 'to', p_owner));
  end if;
  if p_follow_up is distinct from v.follow_up_on then
    insert into private.lead_events (lead_id, actor_id, action, detail) values (p_id, v_me, 'follow_up_changed', jsonb_build_object('from', v.follow_up_on, 'to', p_follow_up));
  end if;
  update private.leads set status = p_status, owner_id = p_owner, follow_up_on = p_follow_up, updated_at = now() where id = p_id;
end;
$$;

create or replace function public.platform_lead_note(p_id uuid, p_note text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.require_platform_admin();
begin
  if trim(coalesce(p_note, '')) = '' or length(p_note) > 4000 then
    raise exception 'Write a note of up to 4000 characters.' using errcode = '22023';
  end if;
  if not exists (select 1 from private.leads where id = p_id) then raise exception 'Lead not found.' using errcode = 'P0002'; end if;
  insert into private.lead_events (lead_id, actor_id, action, note) values (p_id, v_me, 'note_added', trim(p_note));
  update private.leads set updated_at = now() where id = p_id;
end;
$$;

create or replace function public.platform_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_platform_admin();
  return jsonb_build_object(
    'new_leads', (select count(*) from private.leads where status = 'new'),
    'due_follow_ups', (select count(*) from private.leads where follow_up_on <= current_date and status not in ('won', 'lost', 'spam')),
    'open_leads', (select count(*) from private.leads where status not in ('won', 'lost', 'spam')),
    'companies', (select count(*) from public.companies where active and not is_demo),
    'imports_in_review', (select count(*) from private.import_batches where status = 'review'),
    'demo_company', (select jsonb_build_object('id', c.id, 'name', c.name, 'created_at', c.created_at)
                     from public.companies c where c.is_demo and c.active order by c.created_at desc limit 1)
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- 3. Demo company
-- -----------------------------------------------------------------------------
alter table public.companies add column is_demo boolean not null default false;

-- Writes made by platform functions into a company other than the caller's
-- current one (imports, demo set-up). Only ever set inside those functions.
create or replace function private.assign_customer_number()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- new.company_id is the column default (caller's company) or explicit. App
  -- users may only create customers in their own company; refuse before a
  -- number is allocated. (Operators/seed run without auth.uid(); platform
  -- imports set tlt.platform_write inside their own function.)
  if auth.uid() is not null
     and current_setting('tlt.platform_write', true) is distinct from 'on'
     and (new.company_id is null or new.company_id is distinct from private.current_company_id()) then
    raise exception 'You do not have permission to create customers for this company.' using errcode = '42501';
  end if;
  if new.customer_number is null or new.customer_number = '' then
    new.customer_number := private.next_document_number(new.company_id, 'customer');
  end if;
  new.created_by := coalesce(new.created_by, auth.uid());
  new.updated_by := auth.uid();
  return new;
end;
$$;

-- Start a fresh demo: deactivate any earlier demo company (kept, never
-- deleted), create a new one, make the caller its owner and switch to it.
-- The server then fills it with fictional data through the normal app
-- functions, as that owner.
create or replace function public.platform_demo_start(p_timezone text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me  uuid := private.require_platform_admin();
  v_id  uuid;
  v_old integer;
  v_tz  text := coalesce(nullif(trim(p_timezone), ''), 'America/Chicago');
begin
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = v_tz) then
    raise exception 'Unknown time zone.' using errcode = '22023';
  end if;
  update public.company_memberships m set active = false
  from public.companies c where c.id = m.company_id and c.is_demo and c.active;
  update public.companies set active = false where is_demo and active;
  get diagnostics v_old = row_count;

  v_id := private.create_company('Northfield Aggregates (Demo)', 'demo-' || substr(md5(gen_random_uuid()::text), 1, 10));
  update public.companies set is_demo = true where id = v_id;
  update public.company_settings set timezone = v_tz, city = '', state = '' where company_id = v_id;
  insert into public.company_memberships (company_id, user_id, role, active) values (v_id, v_me, 'owner', true);
  update public.profiles set active_company_id = v_id where id = v_me;
  perform private.platform_log('demo_started', 'company', v_id::text, 'Started a fresh demo company',
                               jsonb_build_object('previous_demos_deactivated', v_old));
  return v_id;
end;
$$;

-- Join the current demo company as its owner and switch to it.
create or replace function public.platform_demo_enter()
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.require_platform_admin();
  v_id uuid;
begin
  select id into v_id from public.companies where is_demo and active order by created_at desc limit 1;
  if v_id is null then
    raise exception 'There is no demo company yet. Start one first.' using errcode = 'P0002';
  end if;
  insert into public.company_memberships (company_id, user_id, role, active) values (v_id, v_me, 'owner', true)
  on conflict do nothing;
  update public.company_memberships set active = true, role = 'owner' where company_id = v_id and user_id = v_me;
  update public.profiles set active_company_id = v_id where id = v_me;
  perform private.platform_log('demo_entered', 'company', v_id::text, 'Opened the demo company');
  return v_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- 4. Companies (platform view) and team-led onboarding imports
-- -----------------------------------------------------------------------------
create or replace function public.platform_companies()
returns table (id uuid, name text, slug text, active boolean, is_demo boolean, created_at timestamptz,
               members integer, customers integer, trucks integer, drivers integer, materials integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_platform_admin();
  return query
    select c.id, c.name, c.slug, c.active, c.is_demo, c.created_at,
           (select count(*)::int from public.company_memberships m where m.company_id = c.id and m.active),
           (select count(*)::int from public.customers x where x.company_id = c.id and x.active),
           (select count(*)::int from public.trucks x where x.company_id = c.id and x.active),
           (select count(*)::int from public.drivers x where x.company_id = c.id and x.active),
           (select count(*)::int from public.materials x where x.company_id = c.id and x.active)
    from public.companies c
    where not c.is_demo
    order by c.active desc, c.created_at desc;
end;
$$;

-- Create a customer company for team-led onboarding (no members yet; the
-- owner's login is created afterwards). Optionally linked to a lead.
create or replace function public.platform_create_company(p_name text, p_timezone text, p_lead uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me   uuid := private.require_platform_admin();
  v_name text := trim(coalesce(p_name, ''));
  v_tz   text := coalesce(nullif(trim(p_timezone), ''), 'America/Chicago');
  v_base text;
  v_slug text;
  v_id   uuid;
begin
  if length(v_name) < 2 or length(v_name) > 120 then
    raise exception 'Enter the company name (2 to 120 characters).' using errcode = '22023';
  end if;
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = v_tz) then
    raise exception 'Unknown time zone.' using errcode = '22023';
  end if;
  v_base := trim(both '-' from left(regexp_replace(lower(v_name), '[^a-z0-9]+', '-', 'g'), 40));
  loop
    v_slug := coalesce(nullif(v_base, ''), 'company') || '-' || substr(md5(gen_random_uuid()::text), 1, 6);
    exit when not exists (select 1 from public.companies where slug = v_slug);
  end loop;
  v_id := private.create_company(v_name, v_slug);
  update public.company_settings set timezone = v_tz where company_id = v_id;
  if p_lead is not null then
    update private.leads set status = 'onboarding', updated_at = now() where id = p_lead and status not in ('won', 'onboarding');
    insert into private.lead_events (lead_id, actor_id, action, detail)
    select p_lead, v_me, 'company_created', jsonb_build_object('company_id', v_id, 'company_name', v_name)
    where exists (select 1 from private.leads where id = p_lead);
  end if;
  perform private.platform_log('company_created', 'company', v_id::text, 'Created company ' || v_name,
                               jsonb_build_object('timezone', v_tz, 'lead_id', p_lead));
  return v_id;
end;
$$;

create table private.import_batches (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.companies (id),
  entity         text not null check (entity in ('customers', 'materials', 'trucks', 'drivers')),
  status         text not null default 'review' check (status in ('review', 'approved', 'reverted', 'discarded')),
  file_name      text not null default '' check (length(file_name) <= 200),
  mapping        jsonb not null default '{}'::jsonb,
  created_by     uuid,
  created_at     timestamptz not null default now(),
  decided_by     uuid,
  decided_at     timestamptz,
  reverted_by    uuid,
  reverted_at    timestamptz,
  revert_reason  text not null default '',
  result         jsonb not null default '{}'::jsonb
);
create index import_batches_company on private.import_batches (company_id, created_at desc);

create table private.import_rows (
  id           uuid primary key default gen_random_uuid(),
  batch_id     uuid not null references private.import_batches (id) on delete cascade,
  row_number   integer not null,
  data         jsonb not null,
  status       text not null check (status in ('valid', 'error', 'duplicate')),
  messages     text[] not null default '{}',
  can_override boolean not null default false,
  decision     text not null check (decision in ('import', 'skip')),
  target_id    uuid,
  outcome      text not null default '' check (outcome in ('', 'created', 'removed', 'kept_changed', 'kept_in_use')),
  unique (batch_id, row_number)
);

revoke all on private.import_batches, private.import_rows from public, anon, authenticated;

-- The fields each import accepts (also checked by the server before staging).
create or replace function private.import_fields(p_entity text)
returns text[]
language sql
immutable
set search_path = ''
as $$
  select case p_entity
    when 'customers' then array['name', 'customer_type', 'email', 'phone', 'billing_line1', 'billing_line2', 'billing_city',
                                'billing_state', 'billing_postal_code', 'payment_terms', 'po_required', 'tax_exempt', 'notes']
    when 'materials' then array['name', 'code', 'description', 'default_unit_code', 'taxable_default']
    when 'trucks'    then array['unit_number', 'truck_type', 'make', 'model', 'model_year', 'vin', 'license_plate', 'plate_state', 'notes']
    when 'drivers'   then array['name', 'employee_number', 'phone', 'hire_date', 'notes']
  end
$$;

-- Stage a spreadsheet for review. Nothing is created yet. p_rows is
-- [{row, data: {field: text}, errors: [text]}]; errors found by the server's
-- validation are kept, required fields and allowed values are checked again
-- here, and every row is compared with the company's existing records and
-- with earlier rows of the same file.
create or replace function public.platform_import_stage(p_company uuid, p_entity text, p_file_name text, p_mapping jsonb, p_rows jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me     uuid := private.require_platform_admin();
  v_batch  uuid;
  v_fields text[] := private.import_fields(p_entity);
  r        jsonb;
  v_data   jsonb;
  v_msgs   text[];
  v_status text;
  v_over   boolean;
  v_key    text;
  v_key2   text;
  v_seen   jsonb := '{}'::jsonb;
  v_n      integer := 0;
begin
  if v_fields is null then raise exception 'Unknown import type.' using errcode = '22023'; end if;
  if not exists (select 1 from public.companies where id = p_company and active and not is_demo) then
    raise exception 'Company not found.' using errcode = 'P0002';
  end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'The file has no rows to import.' using errcode = '22023';
  end if;
  if jsonb_array_length(p_rows) > 2000 then
    raise exception 'Import at most 2,000 rows at a time.' using errcode = '22023';
  end if;

  insert into private.import_batches (company_id, entity, file_name, mapping, created_by)
  values (p_company, p_entity, left(coalesce(p_file_name, ''), 200), coalesce(p_mapping, '{}'::jsonb), v_me)
  returning id into v_batch;

  for r in select * from jsonb_array_elements(p_rows) loop
    v_n := v_n + 1;
    -- Keep only known fields, as trimmed text.
    select coalesce(jsonb_object_agg(k, left(trim(r -> 'data' ->> k), 2000)), '{}'::jsonb) into v_data
    from unnest(v_fields) k where nullif(trim(r -> 'data' ->> k), '') is not null;
    select coalesce(array_agg(left(e, 300)), '{}') into v_msgs from jsonb_array_elements_text(coalesce(r -> 'errors', '[]'::jsonb)) e;
    v_over := false;
    v_key := null;
    v_key2 := null;

    -- Required fields and allowed values (again, at the database).
    if p_entity in ('customers', 'materials', 'drivers') and coalesce(v_data ->> 'name', '') = '' then
      v_msgs := array_append(v_msgs, 'Name is required.');
    end if;
    if p_entity = 'customers' and coalesce(v_data ->> 'customer_type', 'commercial') not in ('commercial', 'residential') then
      v_msgs := array_append(v_msgs, 'Customer type must be commercial or residential.');
    end if;
    if p_entity = 'materials' and not exists (select 1 from public.units_of_measure u where u.company_id = p_company and u.code = v_data ->> 'default_unit_code') then
      v_msgs := array_append(v_msgs, 'Unit must be one of the company''s units (ton, load, cu_yd, hour, mile, day, each).');
    end if;
    if p_entity = 'trucks' then
      if coalesce(v_data ->> 'unit_number', '') = '' then v_msgs := array_append(v_msgs, 'Unit number is required.'); end if;
      if coalesce(v_data ->> 'truck_type', '') not in ('single_axle_dump', 'tandem_axle_dump', 'tri_axle_dump', 'quad_axle_dump', 'tractor', 'other') then
        v_msgs := array_append(v_msgs, 'Truck type is not one of the allowed values.');
      end if;
    end if;

    -- Duplicates: against existing records, then within the file.
    if p_entity = 'customers' then
      v_key := 'n:' || lower(v_data ->> 'name');
      v_key2 := case when v_data ? 'email' then 'e:' || lower(v_data ->> 'email') end;
      if exists (select 1 from public.customers c where c.company_id = p_company
                 and (lower(trim(c.name)) = lower(v_data ->> 'name') or (v_data ? 'email' and lower(c.email) = lower(v_data ->> 'email')))) then
        v_msgs := array_append(v_msgs, 'A customer with this name or email already exists.');
        v_over := true;
      end if;
    elsif p_entity = 'materials' then
      v_key := 'n:' || lower(v_data ->> 'name');
      v_key2 := case when v_data ? 'code' then 'c:' || upper(v_data ->> 'code') end;
      if exists (select 1 from public.materials m where m.company_id = p_company
                 and (lower(m.name) = lower(v_data ->> 'name') or (v_data ? 'code' and upper(m.code) = upper(v_data ->> 'code')))) then
        v_msgs := array_append(v_msgs, 'A material with this name or code already exists.');
      end if;
    elsif p_entity = 'trucks' then
      v_key := 'u:' || lower(v_data ->> 'unit_number');
      if exists (select 1 from public.trucks t where t.company_id = p_company and lower(trim(t.unit_number)) = lower(v_data ->> 'unit_number')) then
        v_msgs := array_append(v_msgs, 'A truck with this unit number already exists.');
      end if;
    elsif p_entity = 'drivers' then
      if v_data ? 'employee_number' then
        v_key := 'e:' || lower(v_data ->> 'employee_number');
        if exists (select 1 from public.drivers d where d.company_id = p_company and lower(trim(d.employee_number)) = lower(v_data ->> 'employee_number')) then
          v_msgs := array_append(v_msgs, 'A driver with this employee number already exists.');
        end if;
      else
        v_key := 'n:' || lower(v_data ->> 'name');
        if exists (select 1 from public.drivers d where d.company_id = p_company and lower(trim(d.name)) = lower(v_data ->> 'name')) then
          v_msgs := array_append(v_msgs, 'A driver with this name already exists.');
          v_over := true;
        end if;
      end if;
    end if;
    if (v_key is not null and v_seen ? v_key) or (v_key2 is not null and v_seen ? v_key2) then
      v_msgs := array_append(v_msgs, ('Same as row ' || coalesce(v_seen ->> v_key, v_seen ->> v_key2) || ' of this file.'));
      v_over := false;
    end if;
    if v_key is not null and not v_seen ? v_key then v_seen := v_seen || jsonb_build_object(v_key, coalesce((r ->> 'row')::int, v_n)); end if;
    if v_key2 is not null and not v_seen ? v_key2 then v_seen := v_seen || jsonb_build_object(v_key2, coalesce((r ->> 'row')::int, v_n)); end if;

    -- A row with errors from validation is an error; a row whose only
    -- problem is a match is a duplicate (skipped unless the reviewer decides
    -- otherwise, where the database allows it).
    v_status := case
      when cardinality(v_msgs) = 0 then 'valid'
      when (select bool_and(m like 'A % already exists.' or m like 'Same as row %') from unnest(v_msgs) m) then 'duplicate'
      else 'error' end;
    insert into private.import_rows (batch_id, row_number, data, status, messages, can_override, decision)
    values (v_batch, coalesce((r ->> 'row')::int, v_n), v_data, v_status, v_msgs, v_status = 'duplicate' and v_over,
            case when v_status = 'valid' then 'import' else 'skip' end);
  end loop;

  perform private.platform_log('import_staged', 'import', v_batch::text,
    format('Staged %s %s for review', v_n, p_entity),
    jsonb_build_object('company_id', p_company, 'file_name', left(coalesce(p_file_name, ''), 200)));
  return v_batch;
end;
$$;

create or replace function public.platform_import_batches(p_company uuid)
returns table (id uuid, entity text, status text, file_name text, created_at timestamptz, created_by text,
               rows integer, valid integer, duplicates integer, errors integer, to_import integer, result jsonb)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_platform_admin();
  return query
    select b.id, b.entity, b.status, b.file_name, b.created_at, coalesce(nullif(p.full_name, ''), p.email),
           (select count(*)::int from private.import_rows r where r.batch_id = b.id),
           (select count(*)::int from private.import_rows r where r.batch_id = b.id and r.status = 'valid'),
           (select count(*)::int from private.import_rows r where r.batch_id = b.id and r.status = 'duplicate'),
           (select count(*)::int from private.import_rows r where r.batch_id = b.id and r.status = 'error'),
           (select count(*)::int from private.import_rows r where r.batch_id = b.id and r.decision = 'import'),
           b.result
    from private.import_batches b left join public.profiles p on p.id = b.created_by
    where b.company_id = p_company
    order by b.created_at desc;
end;
$$;

create or replace function public.platform_import_batch(p_batch uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v jsonb;
begin
  perform private.require_platform_admin();
  select to_jsonb(b) || jsonb_build_object('company_name', c.name) into v
  from private.import_batches b join public.companies c on c.id = b.company_id where b.id = p_batch;
  if v is null then return null; end if;
  return v || jsonb_build_object('rows', coalesce((
    select jsonb_agg(jsonb_build_object('id', r.id, 'row', r.row_number, 'data', r.data, 'status', r.status, 'messages', r.messages,
                                        'can_override', r.can_override, 'decision', r.decision, 'outcome', r.outcome) order by r.row_number)
    from private.import_rows r where r.batch_id = p_batch), '[]'::jsonb));
end;
$$;

-- Reviewer's choice for one row while the batch is in review. Rows with
-- errors are never imported; a duplicate may be imported only where the
-- company's records allow two of them (customers, drivers without an
-- employee number).
create or replace function public.platform_import_decide(p_row uuid, p_decision text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v private.import_rows%rowtype;
begin
  perform private.require_platform_admin();
  select r.* into v from private.import_rows r join private.import_batches b on b.id = r.batch_id
  where r.id = p_row and b.status = 'review' for update of r;
  if not found then raise exception 'This row can no longer be changed.' using errcode = 'P0002'; end if;
  if p_decision not in ('import', 'skip') then raise exception 'Unknown decision.' using errcode = '22023'; end if;
  if p_decision = 'import' and not (v.status = 'valid' or (v.status = 'duplicate' and v.can_override)) then
    raise exception 'This row cannot be imported: fix it in the spreadsheet and upload again.' using errcode = '22023';
  end if;
  update private.import_rows set decision = p_decision where id = p_row;
end;
$$;

create or replace function public.platform_import_discard(p_batch uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.require_platform_admin();
  update private.import_batches set status = 'discarded', decided_by = auth.uid(), decided_at = now()
  where id = p_batch and status = 'review';
  if not found then raise exception 'Only a batch in review can be discarded.' using errcode = '22023'; end if;
  perform private.platform_log('import_discarded', 'import', p_batch::text, 'Discarded an import without creating records');
end;
$$;

-- Approve: create every row marked "import", all or nothing.
create or replace function public.platform_import_approve(p_batch uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.require_platform_admin();
  b    private.import_batches%rowtype;
  r    private.import_rows%rowtype;
  d    jsonb;
  v_id uuid;
  v_n  integer := 0;
begin
  select * into b from private.import_batches where id = p_batch for update;
  if not found or b.status <> 'review' then raise exception 'Only a batch in review can be approved.' using errcode = '22023'; end if;
  if not exists (select 1 from public.companies where id = b.company_id and active) then
    raise exception 'The company is no longer active.' using errcode = '22023';
  end if;
  perform set_config('tlt.platform_write', 'on', true);
  for r in select * from private.import_rows where batch_id = p_batch and decision = 'import' order by row_number loop
    d := r.data;
    begin
      if b.entity = 'customers' then
        insert into public.customers (company_id, name, customer_type, email, phone, billing_line1, billing_line2, billing_city,
                                      billing_state, billing_postal_code, payment_terms, po_required, tax_exempt, notes)
        values (b.company_id, d ->> 'name', coalesce(d ->> 'customer_type', 'commercial')::public.customer_type,
                coalesce(d ->> 'email', ''), coalesce(d ->> 'phone', ''), coalesce(d ->> 'billing_line1', ''), coalesce(d ->> 'billing_line2', ''),
                coalesce(d ->> 'billing_city', ''), coalesce(d ->> 'billing_state', ''), coalesce(d ->> 'billing_postal_code', ''),
                coalesce(d ->> 'payment_terms', ''), coalesce((d ->> 'po_required')::boolean, false), coalesce((d ->> 'tax_exempt')::boolean, false),
                coalesce(d ->> 'notes', ''))
        returning id into v_id;
      elsif b.entity = 'materials' then
        insert into public.materials (company_id, name, code, description, default_unit_code, taxable_default)
        values (b.company_id, d ->> 'name', d ->> 'code', coalesce(d ->> 'description', ''), d ->> 'default_unit_code',
                coalesce((d ->> 'taxable_default')::boolean, true))
        returning id into v_id;
      elsif b.entity = 'trucks' then
        insert into public.trucks (company_id, unit_number, truck_type, make, model, model_year, vin, license_plate, plate_state, notes)
        values (b.company_id, d ->> 'unit_number', (d ->> 'truck_type')::public.truck_type, coalesce(d ->> 'make', ''), coalesce(d ->> 'model', ''),
                (d ->> 'model_year')::integer, coalesce(d ->> 'vin', ''), coalesce(d ->> 'license_plate', ''), coalesce(d ->> 'plate_state', ''),
                coalesce(d ->> 'notes', ''))
        returning id into v_id;
      else
        insert into public.drivers (company_id, name, employee_number, phone, hire_date, notes)
        values (b.company_id, d ->> 'name', coalesce(d ->> 'employee_number', ''), coalesce(d ->> 'phone', ''), (d ->> 'hire_date')::date,
                coalesce(d ->> 'notes', ''))
        returning id into v_id;
      end if;
    exception when unique_violation or invalid_text_representation or invalid_datetime_format or datetime_field_overflow
                   or numeric_value_out_of_range or check_violation or not_null_violation or foreign_key_violation then
      raise exception 'Row % could not be imported (%). Nothing was imported.', r.row_number, sqlerrm using errcode = '22023';
    end;
    update private.import_rows set target_id = v_id, outcome = 'created' where id = r.id;
    v_n := v_n + 1;
  end loop;
  perform set_config('tlt.platform_write', 'off', true);
  update private.import_batches set status = 'approved', decided_by = v_me, decided_at = now(),
         result = jsonb_build_object('created', v_n)
  where id = p_batch;
  perform private.platform_log('import_approved', 'import', p_batch::text, format('Approved: created %s %s', v_n, b.entity),
                               jsonb_build_object('company_id', b.company_id, 'created', v_n));
  return jsonb_build_object('created', v_n);
end;
$$;

-- Revert an approved batch: remove only the records this batch created, and
-- only while they are untouched and unused. A record that has been edited
-- (its audit trail shows an update),
-- or that anything else now points to (orders, contacts, rates,
-- qualifications, assignments, tickets...), is kept and deactivated instead.
create or replace function public.platform_import_revert(p_batch uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me      uuid := private.require_platform_admin();
  b         private.import_batches%rowtype;
  r         private.import_rows%rowtype;
  v_changed boolean;
  v_used    boolean;
  v_removed integer := 0;
  v_kept    integer := 0;
begin
  select * into b from private.import_batches where id = p_batch for update;
  if not found or b.status <> 'approved' then raise exception 'Only an approved batch can be reverted.' using errcode = '22023'; end if;
  if trim(coalesce(p_reason, '')) = '' then raise exception 'Give a reason for reverting.' using errcode = '22023'; end if;
  perform set_config('tlt.platform_write', 'on', true);
  for r in select * from private.import_rows where batch_id = p_batch and outcome = 'created' and target_id is not null loop
    if b.entity = 'customers' then
      select exists (select 1 from public.audit_events a where a.entity_id = r.target_id and a.action like '%.updated') into v_changed from public.customers c where c.id = r.target_id and c.company_id = b.company_id;
      v_used := exists (select 1 from public.customer_contacts x where x.customer_id = r.target_id)
             or exists (select 1 from public.customer_sites x where x.customer_id = r.target_id)
             or exists (select 1 from public.quotes x where x.customer_id = r.target_id)
             or exists (select 1 from public.orders x where x.customer_id = r.target_id);
    elsif b.entity = 'materials' then
      select exists (select 1 from public.audit_events a where a.entity_id = r.target_id and a.action like '%.updated') into v_changed from public.materials m where m.id = r.target_id and m.company_id = b.company_id;
      v_used := exists (select 1 from public.price_list_entries x where x.material_id = r.target_id)
             or exists (select 1 from public.quote_lines x where x.material_id = r.target_id)
             or exists (select 1 from public.order_lines x where x.material_id = r.target_id)
             or exists (select 1 from public.delivery_tickets x where x.material_id = r.target_id);
    elsif b.entity = 'trucks' then
      select exists (select 1 from public.audit_events a where a.entity_id = r.target_id and a.action like '%.updated') into v_changed from public.trucks t where t.id = r.target_id and t.company_id = b.company_id;
      v_used := exists (select 1 from public.equipment_status_events x where x.truck_id = r.target_id)
             or exists (select 1 from public.trailers x where x.default_truck_id = r.target_id)
             or exists (select 1 from public.dispatch_assignments x where x.truck_id = r.target_id)
             or exists (select 1 from public.delivery_tickets x where x.truck_id = r.target_id)
             or exists (select 1 from public.field_reports x where x.truck_id = r.target_id);
    else
      select exists (select 1 from public.audit_events a where a.entity_id = r.target_id and a.action like '%.updated') into v_changed from public.drivers d where d.id = r.target_id and d.company_id = b.company_id;
      v_used := exists (select 1 from public.driver_qualifications x where x.driver_id = r.target_id)
             or exists (select 1 from public.dispatch_assignments x where x.driver_id = r.target_id)
             or exists (select 1 from public.delivery_tickets x where x.driver_id = r.target_id)
             or exists (select 1 from public.field_reports x where x.driver_id = r.target_id)
             or exists (select 1 from public.drivers x where x.id = r.target_id and x.user_id is not null);
    end if;
    if v_changed is null then
      -- Already gone (removed by hand): nothing to do.
      update private.import_rows set outcome = 'removed' where id = r.id;
      continue;
    end if;
    if not v_changed and not v_used then
      begin
        if b.entity = 'customers' then delete from public.customers where id = r.target_id and company_id = b.company_id;
        elsif b.entity = 'materials' then delete from public.materials where id = r.target_id and company_id = b.company_id;
        elsif b.entity = 'trucks' then delete from public.trucks where id = r.target_id and company_id = b.company_id;
        else delete from public.drivers where id = r.target_id and company_id = b.company_id;
        end if;
        update private.import_rows set outcome = 'removed' where id = r.id;
        v_removed := v_removed + 1;
        continue;
      exception when foreign_key_violation or insufficient_privilege or raise_exception then
        v_used := true;
      end;
    end if;
    if b.entity = 'customers' then update public.customers set active = false where id = r.target_id and company_id = b.company_id;
    elsif b.entity = 'materials' then update public.materials set active = false where id = r.target_id and company_id = b.company_id;
    elsif b.entity = 'trucks' then update public.trucks set active = false where id = r.target_id and company_id = b.company_id;
    else update public.drivers set active = false where id = r.target_id and company_id = b.company_id;
    end if;
    update private.import_rows set outcome = case when v_used then 'kept_in_use' else 'kept_changed' end where id = r.id;
    v_kept := v_kept + 1;
  end loop;
  perform set_config('tlt.platform_write', 'off', true);
  update private.import_batches set status = 'reverted', reverted_by = v_me, reverted_at = now(), revert_reason = trim(p_reason),
         result = result || jsonb_build_object('removed', v_removed, 'kept_inactive', v_kept)
  where id = p_batch;
  perform private.platform_log('import_reverted', 'import', p_batch::text,
    format('Reverted: removed %s, kept %s (deactivated)', v_removed, v_kept),
    jsonb_build_object('company_id', b.company_id, 'removed', v_removed, 'kept_inactive', v_kept, 'reason', trim(p_reason)));
  return jsonb_build_object('removed', v_removed, 'kept_inactive', v_kept);
end;
$$;

-- -----------------------------------------------------------------------------
-- 5. Privileges
-- -----------------------------------------------------------------------------
revoke execute on function
  private.platform_audit_append_only(), private.is_platform_admin(), private.require_platform_admin(),
  private.platform_log(text, text, text, text, jsonb), private.import_fields(text)
from public, anon, authenticated;

-- Operator and website server only.
revoke execute on function
  public.platform_admin_grant(text, text), public.platform_admin_revoke(text, text), public.platform_admin_list(),
  public.lead_submit(jsonb, text)
from public, anon, authenticated;
grant execute on function
  public.platform_admin_grant(text, text), public.platform_admin_revoke(text, text), public.platform_admin_list(),
  public.lead_submit(jsonb, text)
to service_role;

-- Signed-in users; each function checks for a platform admin itself.
revoke execute on function
  public.platform_whoami(), public.platform_team(), public.platform_audit_recent(integer),
  public.platform_leads(text, text, boolean), public.platform_lead(uuid), public.platform_lead_update(uuid, text, uuid, date),
  public.platform_lead_note(uuid, text), public.platform_overview(), public.platform_demo_start(text), public.platform_demo_enter(),
  public.platform_companies(), public.platform_create_company(text, text, uuid),
  public.platform_import_stage(uuid, text, text, jsonb, jsonb), public.platform_import_batches(uuid), public.platform_import_batch(uuid),
  public.platform_import_decide(uuid, text), public.platform_import_discard(uuid), public.platform_import_approve(uuid),
  public.platform_import_revert(uuid, text)
from public, anon;
grant execute on function
  public.platform_whoami(), public.platform_team(), public.platform_audit_recent(integer),
  public.platform_leads(text, text, boolean), public.platform_lead(uuid), public.platform_lead_update(uuid, text, uuid, date),
  public.platform_lead_note(uuid, text), public.platform_overview(), public.platform_demo_start(text), public.platform_demo_enter(),
  public.platform_companies(), public.platform_create_company(text, text, uuid),
  public.platform_import_stage(uuid, text, text, jsonb, jsonb), public.platform_import_batches(uuid), public.platform_import_batch(uuid),
  public.platform_import_decide(uuid, text), public.platform_import_discard(uuid), public.platform_import_approve(uuid),
  public.platform_import_revert(uuid, text)
to authenticated;
