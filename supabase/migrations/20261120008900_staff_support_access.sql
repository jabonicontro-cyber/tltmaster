-- Taviron staff and support access (SA1, owner 2026-11-06).
--   * Two staff levels on private.platform_admins: 'admin' (everything, including plans, prices, subscriptions and the
--     team) and 'support' (enter companies to help, nothing else in the console). Existing rows stay 'admin'.
--     private.is_platform_admin() now means the admin level; private.is_platform_staff() means either level.
--   * Staff are invited from the console by an admin who has just entered their password and authenticator code
--     (private.require_fresh_reauth). The invite is a single-use link (only its hash is stored, valid 7 days); the
--     invitee sets a password, sets up an authenticator app and accepts. Every invite, join, level change and removal
--     is in the platform audit log. scripts/platform-admin.mjs keeps working as the operator's fallback.
--   * A live customer company lets Taviron in only through a grant its owner gives in Settings: 1, 3 (default) or
--     7 days, ended at any time, ending on its own. Companies still onboarding (fee due or onboarding) and demo
--     companies need no grant; a visit without a grant lasts up to 8 hours.
--   * A support visit is a private.support_sessions row, not a membership: staff act with the owner role inside the
--     company (private.current_company_id, has_permission, current_app_role, my_access) but are never listed as
--     people, never counted as owners, never emailed and never offered as assignees. A visit ends when the staff
--     member leaves, the grant ends or is ended, the company goes live without a grant, or the staff member is removed.
--   * Visits and grants are recorded in the company's own audit log; history shows staff as "Name (Taviron support)"
--     (public.support_actor_names). Owners see a banner while staff are inside (my_access.support_inside).
-- No emails are sent by the database. Reversible: supabase/rollbacks/20261120008900_staff_support_access.down.sql.

-- 1. Staff levels -----------------------------------------------------------------------------------------------------

alter table private.platform_admins add column level text not null default 'admin' check (level in ('admin', 'support'));

create or replace function private.is_platform_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null
     and exists (select 1 from private.platform_admins a where a.user_id = auth.uid() and a.revoked_at is null and a.level = 'admin')
$$;

create or replace function private.is_platform_staff()
returns boolean language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null
     and exists (select 1 from private.platform_admins a where a.user_id = auth.uid() and a.revoked_at is null)
$$;
revoke all on function private.is_platform_staff() from public, anon, authenticated;

create or replace function private.require_platform_staff()
returns uuid language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_platform_staff() then
    raise exception 'Not available.' using errcode = '42501';
  end if;
  if private.platform_mfa_enforced() and not private.aal2() then
    raise exception 'Two-step verification is required for the platform console.' using errcode = '42501';
  end if;
  return auth.uid();
end;
$$;
revoke all on function private.require_platform_staff() from public, anon, authenticated;

-- The caller's staff level ('admin', 'support') or null. Used by the app to route the console; every function checks again.
create or replace function public.platform_staff_whoami()
returns text language sql stable security definer set search_path = '' as $$
  select a.level from private.platform_admins a where a.user_id = auth.uid() and a.revoked_at is null
$$;
revoke all on function public.platform_staff_whoami() from public, anon;
grant execute on function public.platform_staff_whoami() to authenticated;

-- Two-step verification is mandatory for every staff level (it was for admins).
create or replace function public.mfa_policy()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'platform', private.is_platform_staff() and private.platform_mfa_enforced(),
    'companies', coalesce((select jsonb_agg(c.name order by c.name)
                           from public.company_memberships m
                           join public.companies c on c.id = m.company_id and c.active
                           join public.company_settings s on s.company_id = c.id
                           where m.user_id = auth.uid() and m.active and s.require_mfa), '[]'::jsonb),
    'current_company', coalesce((select s.require_mfa from public.company_settings s where s.company_id = private.current_company_id_any()), false),
    'enrolled', private.mfa_enrolled(),
    'recovery_codes', (select count(*) from private.mfa_recovery_codes r where r.user_id = auth.uid() and r.used_at is null),
    'recent_failures', (select count(*) from private.mfa_attempts a where a.user_id = auth.uid() and not a.ok and a.at > now() - interval '15 minutes'),
    'aal2', private.aal2());
$$;

-- 2. Fresh re-authentication: password and authenticator code entered again within the last 5 minutes ---------------

create or replace function private.require_fresh_reauth()
returns void language plpgsql stable security definer set search_path = '' as $$
declare
  v_signed timestamptz;
begin
  select u.last_sign_in_at into v_signed from auth.users u where u.id = auth.uid();
  if v_signed is null or v_signed < now() - interval '5 minutes'
     or not exists (select 1 from auth.mfa_challenges c join auth.mfa_factors f on f.id = c.factor_id
                    where f.user_id = auth.uid() and f.status = 'verified' and c.verified_at >= now() - interval '5 minutes') then
    raise exception 'Enter your password and authenticator code again to do this.' using errcode = '42501';
  end if;
end;
$$;
revoke all on function private.require_fresh_reauth() from public, anon, authenticated;

-- 3. Staff invites ----------------------------------------------------------------------------------------------------

create table private.platform_staff_invites (
  id          uuid primary key default gen_random_uuid(),
  email       text not null check (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' and length(email) <= 254),
  full_name   text not null default '' check (length(full_name) <= 120),
  level       text not null check (level in ('admin', 'support')),
  token_hash  text not null unique,
  invited_by  uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  accepted_at timestamptz,
  accepted_by uuid references auth.users (id) on delete set null,
  revoked_at  timestamptz,
  revoked_by  uuid references auth.users (id) on delete set null
);
create unique index platform_staff_invites_open on private.platform_staff_invites (lower(email)) where accepted_at is null and revoked_at is null;
alter table private.platform_staff_invites enable row level security;

create or replace function private.staff_token_hash(p_token text)
returns text language sql immutable set search_path = '' as $$
  select encode(sha256(convert_to(coalesce(p_token, ''), 'UTF8')), 'hex')
$$;
revoke all on function private.staff_token_hash(text) from public, anon, authenticated;

create or replace function public.platform_staff_invite(p_email text, p_full_name text, p_level text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_admin uuid;
  v_email text := lower(trim(coalesce(p_email, '')));
  v_name  text := trim(coalesce(p_full_name, ''));
  v_token text;
  v_id    uuid;
  v_exp   timestamptz := now() + interval '7 days';
begin
  v_admin := private.require_platform_admin();
  perform private.require_fresh_reauth();
  if p_level not in ('admin', 'support') then raise exception 'Choose Support or Admin.' using errcode = '22023'; end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or length(v_email) > 254 then raise exception 'Enter a valid email address.' using errcode = '22023'; end if;
  if length(v_name) < 2 or length(v_name) > 120 then raise exception 'Enter the person''s name.' using errcode = '22023'; end if;
  if exists (select 1 from private.platform_admins a join auth.users u on u.id = a.user_id where lower(u.email) = v_email and a.revoked_at is null) then
    raise exception 'That person is already on the Taviron team.' using errcode = 'P0001';
  end if;
  update private.platform_staff_invites set revoked_at = now(), revoked_by = v_admin
   where lower(email) = v_email and accepted_at is null and revoked_at is null;
  v_token := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  insert into private.platform_staff_invites (email, full_name, level, token_hash, invited_by, expires_at)
  values (v_email, v_name, p_level, private.staff_token_hash(v_token), v_admin, v_exp)
  returning id into v_id;
  perform private.platform_log('staff_invited', 'staff_invite', v_id::text,
    format('Invited %s (%s) as %s', v_name, v_email, case p_level when 'admin' then 'Admin' else 'Support' end),
    jsonb_build_object('email', v_email, 'level', p_level));
  return jsonb_build_object('id', v_id, 'token', v_token, 'expires_at', v_exp, 'email', v_email, 'full_name', v_name, 'level', p_level);
end;
$$;
revoke all on function public.platform_staff_invite(text, text, text) from public, anon;
grant execute on function public.platform_staff_invite(text, text, text) to authenticated;

create or replace function public.platform_staff_invite_revoke(p_invite uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_admin uuid;
  v private.platform_staff_invites;
begin
  v_admin := private.require_platform_admin();
  update private.platform_staff_invites set revoked_at = now(), revoked_by = v_admin
   where id = p_invite and accepted_at is null and revoked_at is null
  returning * into v;
  if v.id is null then raise exception 'That invitation is no longer open.' using errcode = 'P0002'; end if;
  perform private.platform_log('staff_invite_revoked', 'staff_invite', v.id::text, format('Withdrew the invitation for %s', v.email), jsonb_build_object('email', v.email));
end;
$$;
revoke all on function public.platform_staff_invite_revoke(uuid) from public, anon;
grant execute on function public.platform_staff_invite_revoke(uuid) to authenticated;

-- Open invitations and those settled in the last 30 days.
create or replace function public.platform_staff_invites()
returns table (id uuid, email text, full_name text, level text, status text, created_at timestamptz, expires_at timestamptz, invited_by text)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_platform_admin();
  return query
    select i.id, i.email, i.full_name, i.level,
           case when i.accepted_at is not null then 'accepted' when i.revoked_at is not null then 'withdrawn'
                when i.expires_at <= now() then 'expired' else 'open' end,
           i.created_at, i.expires_at, coalesce(nullif(p.full_name, ''), p.email, '')
    from private.platform_staff_invites i
    left join public.profiles p on p.id = i.invited_by
    where (i.accepted_at is null and i.revoked_at is null) or i.created_at > now() - interval '30 days'
    order by i.created_at desc
    limit 50;
end;
$$;
revoke all on function public.platform_staff_invites() from public, anon;
grant execute on function public.platform_staff_invites() to authenticated;

-- What the join page shows to whoever holds the link (the token is the secret).
create or replace function public.staff_invite_peek(p_token text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select jsonb_build_object(
       'status', case when i.accepted_at is not null then 'used' when i.revoked_at is not null then 'withdrawn'
                      when i.expires_at <= now() then 'expired' else 'open' end,
       'email', i.email, 'full_name', i.full_name, 'level', i.level, 'expires_at', i.expires_at,
       'has_account', exists (select 1 from auth.users u where lower(u.email) = i.email))
     from private.platform_staff_invites i where i.token_hash = private.staff_token_hash(p_token)),
    jsonb_build_object('status', 'invalid'))
$$;
revoke all on function public.staff_invite_peek(text) from public;
grant execute on function public.staff_invite_peek(text) to anon, authenticated;

-- Accept: signed in as the invited email, with an authenticator app verified in this session.
create or replace function public.platform_staff_accept(p_token text)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v private.platform_staff_invites;
  v_email text;
begin
  if auth.uid() is null then raise exception 'Sign in first.' using errcode = '42501'; end if;
  select * into v from private.platform_staff_invites where token_hash = private.staff_token_hash(p_token) for update;
  if v.id is null or v.accepted_at is not null or v.revoked_at is not null or v.expires_at <= now() then
    raise exception 'This invitation is no longer valid. Ask for a new one.' using errcode = 'P0002';
  end if;
  select lower(u.email) into v_email from auth.users u where u.id = auth.uid();
  if v_email is distinct from v.email then
    raise exception 'This invitation is for %. Sign in with that email.', v.email using errcode = '42501';
  end if;
  if not exists (select 1 from auth.mfa_factors f where f.user_id = auth.uid() and f.status = 'verified' and f.factor_type = 'totp') or not private.aal2() then
    raise exception 'Set up an authenticator app and enter its code first.' using errcode = '42501';
  end if;
  insert into private.platform_admins (user_id, note, level)
  values (auth.uid(), format('Invited %s', to_char(v.created_at, 'YYYY-MM-DD')), v.level)
  on conflict (user_id) do update set revoked_at = null, revoke_note = '', level = excluded.level, note = excluded.note, granted_at = now();
  update private.platform_staff_invites set accepted_at = now(), accepted_by = auth.uid() where id = v.id;
  update public.profiles set full_name = v.full_name where id = auth.uid() and coalesce(full_name, '') = '' and v.full_name <> '';
  perform private.platform_log('staff_joined', 'user', auth.uid()::text,
    format('%s joined the team as %s', coalesce(nullif(v.full_name, ''), v.email), case v.level when 'admin' then 'Admin' else 'Support' end),
    jsonb_build_object('email', v.email, 'level', v.level, 'invite', v.id, 'invited_by', v.invited_by));
  return v.level;
end;
$$;
revoke all on function public.platform_staff_accept(text) from public, anon;
grant execute on function public.platform_staff_accept(text) to authenticated;

create or replace function public.platform_staff_list()
returns table (user_id uuid, full_name text, email text, level text, granted_at timestamptz, is_me boolean)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_platform_admin();
  return query
    select a.user_id, coalesce(p.full_name, ''), coalesce(p.email, ''), a.level, a.granted_at, a.user_id = auth.uid()
    from private.platform_admins a left join public.profiles p on p.id = a.user_id
    where a.revoked_at is null
    order by a.level, p.full_name, p.email;
end;
$$;
revoke all on function public.platform_staff_list() from public, anon;
grant execute on function public.platform_staff_list() to authenticated;

create or replace function public.platform_staff_set_level(p_user uuid, p_level text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_admin uuid;
  v_old text;
begin
  v_admin := private.require_platform_admin();
  if p_level not in ('admin', 'support') then raise exception 'Choose Support or Admin.' using errcode = '22023'; end if;
  select level into v_old from private.platform_admins where user_id = p_user and revoked_at is null for update;
  if v_old is null then raise exception 'That person is not on the team.' using errcode = 'P0002'; end if;
  if v_old = p_level then return; end if;
  if p_level = 'admin' then perform private.require_fresh_reauth(); end if;
  if v_old = 'admin' and not exists (select 1 from private.platform_admins where level = 'admin' and revoked_at is null and user_id <> p_user) then
    raise exception 'The team needs at least one Admin.' using errcode = 'P0001';
  end if;
  update private.platform_admins set level = p_level where user_id = p_user;
  perform private.platform_log('staff_level_changed', 'user', p_user::text,
    format('Changed to %s', case p_level when 'admin' then 'Admin' else 'Support' end), jsonb_build_object('from', v_old, 'to', p_level));
end;
$$;
revoke all on function public.platform_staff_set_level(uuid, text) from public, anon;
grant execute on function public.platform_staff_set_level(uuid, text) to authenticated;

alter table private.company_lifecycle add column created_at timestamptz not null default now();

-- 4. Customer grants --------------------------------------------------------------------------------------------------

create table public.support_access_grants (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  days       integer not null check (days in (1, 3, 7)),
  granted_by uuid references auth.users (id) on delete set null,
  starts_at  timestamptz not null default now(),
  ends_at    timestamptz not null,
  ended_at   timestamptz,
  ended_by   uuid references auth.users (id) on delete set null,
  check (ends_at > starts_at)
);
create unique index support_access_grants_open on public.support_access_grants (company_id) where ended_at is null;
create index support_access_grants_company on public.support_access_grants (company_id, starts_at desc);
-- Row-level security with no policy: read through public.support_access_status() (owners) only.
alter table public.support_access_grants enable row level security;
create trigger a_company_guard before update of company_id on public.support_access_grants
  for each row execute function private.forbid_company_change();
revoke insert, update, delete on public.support_access_grants from anon, authenticated;

-- A customer company needs its owner's grant once anyone uses it. It does not only while it is still being set up:
-- a demo company, a company with no active owner yet, or one whose subscription record (fee due or onboarding) was
-- made before its first active owner joined (the console's onboarding order). A company that was already in use when
-- its subscription record was made (Top Line and every customer from before the lifecycle) keeps needing a grant
-- (security review 2026-11-06, M2). Existing records count as made now, so they need a grant too: the safe side.
create or replace function private.support_needs_grant(p_company uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select not coalesce((select c.is_demo from public.companies c where c.id = p_company), false)
     and exists (select 1 from public.company_memberships m where m.company_id = p_company and m.active and m.role = 'owner')
     and not coalesce((select l.stage in ('fee_due', 'onboarding')
                              and l.created_at <= (select min(m.created_at) from public.company_memberships m
                                                    where m.company_id = p_company and m.active and m.role = 'owner')
                       from private.company_lifecycle l where l.company_id = p_company), false)
$$;
revoke all on function private.support_needs_grant(uuid) from public, anon, authenticated;

create or replace function private.support_open_grant(p_company uuid)
returns public.support_access_grants language sql stable security definer set search_path = '' as $$
  select g.* from public.support_access_grants g
  where g.company_id = p_company and g.ended_at is null and g.ends_at > now()
  limit 1
$$;
revoke all on function private.support_open_grant(uuid) from public, anon, authenticated;

-- 5. Support visits ---------------------------------------------------------------------------------------------------

create table private.support_sessions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  company_id uuid not null references public.companies (id) on delete cascade,
  grant_id   uuid references public.support_access_grants (id) on delete set null,
  reason     text not null default '' check (length(reason) <= 300),
  started_at timestamptz not null default now(),
  ends_at    timestamptz not null,
  ended_at   timestamptz,
  end_reason text not null default '' check (end_reason in ('', 'left', 'switched', 'access_ended', 'staff_removed'))
);
create index support_sessions_open on private.support_sessions (user_id) where ended_at is null;
create index support_sessions_company on private.support_sessions (company_id, started_at desc);
alter table private.support_sessions enable row level security;

-- The company the caller is visiting as Taviron support right now, or null. Checked on every request: an active staff
-- member, two-step verified, an active company, an open visit, and a grant that is still open (or no grant needed).
create or replace function private.support_company()
returns uuid language sql stable security definer set search_path = '' as $$
  select s.company_id
  from private.support_sessions s
  join public.companies c on c.id = s.company_id and c.active
  join private.platform_admins a on a.user_id = s.user_id and a.revoked_at is null
  where s.user_id = auth.uid() and s.ended_at is null and s.ends_at > now()
    and (not private.platform_mfa_enforced() or private.aal2())
    and (case when s.grant_id is null then not private.support_needs_grant(s.company_id)
              else exists (select 1 from public.support_access_grants g where g.id = s.grant_id and g.ended_at is null and g.ends_at > now()) end)
  order by s.started_at desc
  limit 1
$$;
revoke all on function private.support_company() from public, anon, authenticated;

-- Identity: a visit comes first; otherwise the membership choice as before (20261120006300).
create or replace function private.current_company_id()
returns uuid language sql stable security definer set search_path = '' as $$
  -- One query, cheapest test first (it runs inside most row-level security policies). Same membership choice as
  -- private.current_company_id_any(). No company below aal2 for enrolled/required two-step (20261120001100), none
  -- while first sign-in setup is pending (20261120001200), and none once a time-limited access ended (20261120006300).
  -- A Taviron support visit (20261120008900) takes precedence while it lasts.
  select coalesce(private.support_company(), (
  select case
    when x.company_id is null then null
    when exists (select 1 from private.account_setups s where s.user_id = auth.uid() and s.status = 'setup_required') then null
    when coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2' then x.company_id
    when exists (select 1 from auth.mfa_factors f where f.user_id = auth.uid() and f.status = 'verified') then null
    when coalesce((select s.require_mfa from public.company_settings s where s.company_id = x.company_id), false) then null
    else x.company_id
  end
  from (select (
    select m.company_id
    from public.company_memberships m
    join public.companies c on c.id = m.company_id and c.active
    join public.profiles p on p.id = m.user_id
    where m.user_id = auth.uid()
      and m.active
      and m.role is not null
      and (m.access_ends_at is null or m.access_ends_at > now())
    order by (m.company_id = p.active_company_id) desc nulls last, m.created_at, m.company_id
    limit 1) as company_id) x))
$$;

create or replace function private.current_company_id_any()
returns uuid language sql stable security definer set search_path = '' as $$
  select coalesce(private.support_company(), (
  select m.company_id
  from public.company_memberships m
  join public.companies c on c.id = m.company_id and c.active
  join public.profiles p on p.id = m.user_id
  where m.user_id = auth.uid()
    and m.active
    and m.role is not null
    and (m.access_ends_at is null or m.access_ends_at > now())
  order by (m.company_id = p.active_company_id) desc nulls last, m.created_at, m.company_id
  limit 1))
$$;

-- During a visit, staff hold the company's owner permissions (owner decision: full access upon entry).
create or replace function private.has_permission(p_permission text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.company_memberships m
    join public.role_permissions rp
      on rp.company_id = m.company_id and rp.role = m.role
    where m.user_id = auth.uid()
      and m.company_id = private.current_company_id()
      and m.active
      and rp.permission = p_permission
  ) or exists (
    select 1 from public.role_permissions rp
    where rp.company_id = private.support_company() and rp.role = 'owner' and rp.permission = p_permission
  )
$$;

create or replace function private.current_app_role()
returns public.app_role language sql stable security definer set search_path = '' as $$
  select case when private.support_company() is not null then 'owner'::public.app_role else (
    select m.role
    from public.company_memberships m
    where m.user_id = auth.uid()
      and m.company_id = private.current_company_id()) end
$$;

create or replace function private.require_owner()
returns uuid language plpgsql stable security definer set search_path = '' as $$
declare
  v_company uuid := private.require_company();
begin
  if private.support_company() = v_company then return v_company; end if;
  if not exists (select 1 from public.company_memberships m where m.company_id = v_company and m.user_id = auth.uid() and m.active and m.role = 'owner') then
    raise exception 'Only an owner can give or change an accountant''s access.' using errcode = '42501';
  end if;
  return v_company;
end;
$$;

-- Staff can read the company they are visiting (the existing policy covers memberships; during a visit the current
-- company is the visited one).
create policy companies_read_support on public.companies for select to authenticated
  using (id = (select private.current_company_id()));

create or replace function public.my_access()
returns jsonb language sql stable security definer set search_path = '' as $$
  with cur as (select private.current_company_id() as company_id, private.support_company() as support_company),
  m as (
    -- The current company's membership, or (for users waiting for access) any membership.
    select m.*
    from public.company_memberships m, cur
    where m.user_id = auth.uid()
    order by (m.company_id = cur.company_id) desc nulls last, m.created_at
    limit 1
  ),
  visit as (
    select s.ends_at, s.started_at from private.support_sessions s, cur
    where cur.support_company is not null and s.user_id = auth.uid() and s.company_id = cur.support_company and s.ended_at is null
    order by s.started_at desc limit 1
  )
  select jsonb_build_object(
    'user_id', p.id,
    'email', p.email,
    'full_name', p.full_name,
    'company_id', cur.company_id,
    'company_name', (select c.name from public.companies c where c.id = cur.company_id),
    'role', case when cur.support_company is not null then 'owner'::public.app_role when cur.company_id is not null then m.role end,
    'active', case when cur.support_company is not null then true
                   else coalesce(m.active, true) and (m.company_id is null or exists (select 1 from public.companies c where c.id = m.company_id and c.active)) end,
    'membership_count', (select count(*) from public.company_memberships x where x.user_id = p.id and x.active and x.role is not null),
    'permissions', coalesce(
      (select jsonb_agg(rp.permission order by rp.permission)
       from public.role_permissions rp
       where cur.company_id is not null and rp.company_id = cur.company_id
         and ((cur.support_company is not null and rp.role = 'owner')
              or (cur.support_company is null and rp.role = m.role and m.active))),
      '[]'::jsonb),
    'support', (select jsonb_build_object('ends_at', v.ends_at, 'started_at', v.started_at) from visit v),
    'support_inside', coalesce(cur.support_company is null and cur.company_id is not null and m.role = 'owner'
      and exists (select 1 from private.support_sessions s where s.company_id = cur.company_id and s.ended_at is null and s.ends_at > now()), false)
  )
  from public.profiles p
  cross join cur
  left join m on true
  where p.id = auth.uid()
$$;

-- Company audit entry for a grant or visit (explicit company: the visit may have just started or ended).
create or replace function private.support_audit(p_company uuid, p_action text, p_summary text, p_details jsonb)
returns void language sql security definer set search_path = '' as $$
  insert into public.audit_events (company_id, actor_id, action, entity_type, entity_id, summary, details)
  values (p_company, auth.uid(), p_action, 'company', p_company, p_summary, coalesce(p_details, '{}'::jsonb));
$$;
revoke all on function private.support_audit(uuid, text, text, jsonb) from public, anon, authenticated;

create or replace function private.staff_name(p_user uuid)
returns text language sql stable security definer set search_path = '' as $$
  select coalesce(nullif((select p.full_name from public.profiles p where p.id = p_user), ''), (select p.email from public.profiles p where p.id = p_user), 'Taviron')
$$;
revoke all on function private.staff_name(uuid) from public, anon, authenticated;

-- Owner (a real owner, never a visiting staff member): give access for 1, 3 or 7 days. Replaces an open grant, and
-- visits under it continue until the new end.
create or replace function public.support_access_grant(p_days integer)
returns timestamptz language plpgsql security definer set search_path = '' as $$
declare
  v_company uuid := private.require_company();
  v_old uuid;
  v_new uuid;
  v_end timestamptz;
begin
  if private.support_company() is not null
     or not exists (select 1 from public.company_memberships m where m.company_id = v_company and m.user_id = auth.uid() and m.active and m.role = 'owner') then
    raise exception 'Only an owner of the company can give Taviron support access.' using errcode = '42501';
  end if;
  if p_days not in (1, 3, 7) then raise exception 'Choose 1, 3 or 7 days.' using errcode = '22023'; end if;
  -- Close the open grant (an expired one ends at its own end).
  update public.support_access_grants set ended_at = least(now(), ends_at), ended_by = case when ends_at > now() then auth.uid() end
   where company_id = v_company and ended_at is null
  returning id into v_old;
  v_end := now() + make_interval(days => p_days);
  insert into public.support_access_grants (company_id, days, granted_by, ends_at) values (v_company, p_days, auth.uid(), v_end)
  returning id into v_new;
  if v_old is not null then
    update private.support_sessions set grant_id = v_new, ends_at = v_end where grant_id = v_old and ended_at is null;
  end if;
  perform private.support_audit(v_company, 'support_access.granted',
    format('Gave Taviron support access for %s %s', p_days, case p_days when 1 then 'day' else 'days' end),
    jsonb_build_object('days', p_days, 'ends_at', v_end));
  return v_end;
end;
$$;
revoke all on function public.support_access_grant(integer) from public, anon;
grant execute on function public.support_access_grant(integer) to authenticated;

-- Owner: end access now. Anyone from Taviron inside is signed out of the company at once.
create or replace function public.support_access_end()
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_company uuid := private.require_company();
  v_n integer;
begin
  if private.support_company() is not null
     or not exists (select 1 from public.company_memberships m where m.company_id = v_company and m.user_id = auth.uid() and m.active and m.role = 'owner') then
    raise exception 'Only an owner of the company can end Taviron support access.' using errcode = '42501';
  end if;
  update public.support_access_grants set ended_at = now(), ended_by = auth.uid()
   where company_id = v_company and ended_at is null and ends_at > now();
  get diagnostics v_n = row_count;
  update public.support_access_grants set ended_at = ends_at where company_id = v_company and ended_at is null;
  update private.support_sessions set ended_at = now(), end_reason = 'access_ended' where company_id = v_company and ended_at is null;
  if v_n > 0 then
    perform private.support_audit(v_company, 'support_access.ended', 'Ended Taviron support access', '{}'::jsonb);
  end if;
end;
$$;
revoke all on function public.support_access_end() from public, anon;
grant execute on function public.support_access_end() to authenticated;

-- For the company's owners (and staff visiting): the open grant, who is inside, and recent grants and visits.
create or replace function public.support_access_status()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_company uuid := private.require_company();
  g public.support_access_grants;
begin
  if private.current_app_role() is distinct from 'owner' then
    raise exception 'Only an owner can see Taviron support access.' using errcode = '42501';
  end if;
  g := private.support_open_grant(v_company);
  return jsonb_build_object(
    'needs_grant', private.support_needs_grant(v_company),
    'grant', case when g.id is null then null else jsonb_build_object('days', g.days, 'starts_at', g.starts_at, 'ends_at', g.ends_at, 'granted_by', private.staff_name(g.granted_by)) end,
    'inside', coalesce((select jsonb_agg(jsonb_build_object('name', private.staff_name(s.user_id), 'started_at', s.started_at, 'ends_at', s.ends_at) order by s.started_at)
                        from private.support_sessions s where s.company_id = v_company and s.ended_at is null and s.ends_at > now()), '[]'::jsonb),
    'visits', coalesce((select jsonb_agg(x order by x->>'started_at' desc) from (
                          select jsonb_build_object('name', private.staff_name(s.user_id), 'reason', s.reason, 'started_at', s.started_at,
                                                    'ended_at', coalesce(s.ended_at, case when s.ends_at <= now() then s.ends_at end), 'end_reason', s.end_reason) as x
                          from private.support_sessions s where s.company_id = v_company order by s.started_at desc limit 20) v), '[]'::jsonb),
    'grants', coalesce((select jsonb_agg(x order by x->>'starts_at' desc) from (
                          select jsonb_build_object('days', a.days, 'starts_at', a.starts_at, 'ends_at', a.ends_at, 'ended_at', a.ended_at,
                                                    'granted_by', private.staff_name(a.granted_by), 'ended_by', case when a.ended_by is not null then private.staff_name(a.ended_by) end) as x
                          from public.support_access_grants a where a.company_id = v_company order by a.starts_at desc limit 10) v), '[]'::jsonb));
end;
$$;
revoke all on function public.support_access_status() from public, anon;
grant execute on function public.support_access_status() to authenticated;

-- History names for staff who visited this company: "Name (Taviron support)". Any member may read them.
create or replace function public.support_actor_names()
returns table (user_id uuid, name text) language plpgsql stable security definer set search_path = '' as $$
declare
  v_company uuid := private.require_company();
begin
  return query
    select distinct s.user_id, private.staff_name(s.user_id) || ' (Taviron support)'
    from private.support_sessions s where s.company_id = v_company;
end;
$$;
revoke all on function public.support_actor_names() from public, anon;
grant execute on function public.support_actor_names() to authenticated;

-- Staff: the companies they can help, with whether they can go in now.
create or replace function public.platform_support_companies()
returns table (id uuid, name text, is_demo boolean, stage text, needs_grant boolean, grant_ends_at timestamptz, can_enter boolean, my_visit_ends_at timestamptz, last_visit_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_platform_staff();
  return query
    select c.id, c.name, c.is_demo, coalesce(l.stage, case when c.is_demo then 'demo' else 'live' end),
           private.support_needs_grant(c.id), g.ends_at,
           not private.support_needs_grant(c.id) or g.id is not null,
           (select s.ends_at from private.support_sessions s where s.user_id = auth.uid() and s.company_id = c.id and s.ended_at is null and s.ends_at > now() limit 1),
           (select max(s.started_at) from private.support_sessions s where s.company_id = c.id)
    from public.companies c
    left join private.company_lifecycle l on l.company_id = c.id
    left join lateral (select x.id, x.ends_at from public.support_access_grants x where x.company_id = c.id and x.ended_at is null and x.ends_at > now() limit 1) g on true
    where c.active
    order by c.is_demo, (not private.support_needs_grant(c.id) or g.id is not null) desc, c.name;
end;
$$;
revoke all on function public.platform_support_companies() from public, anon;
grant execute on function public.platform_support_companies() to authenticated;

-- Staff: go into a company. Live companies need an open grant (the visit ends with it); others up to 8 hours.
create or replace function public.platform_support_enter(p_company uuid, p_reason text)
returns timestamptz language plpgsql security definer set search_path = '' as $$
declare
  v_staff uuid := private.require_platform_staff();
  v_name text;
  g public.support_access_grants;
  v_end timestamptz;
  v_reason text := left(trim(coalesce(p_reason, '')), 300);
begin
  select c.name into v_name from public.companies c where c.id = p_company and c.active;
  if v_name is null then raise exception 'Company not found.' using errcode = 'P0002'; end if;
  if private.support_needs_grant(p_company) then
    g := private.support_open_grant(p_company);
    if g.id is null then
      raise exception '% has not given Taviron support access. An owner turns it on in Settings, Taviron support.', v_name using errcode = '42501';
    end if;
    v_end := g.ends_at;
  else
    v_end := now() + interval '8 hours';
  end if;
  update private.support_sessions set ended_at = now(), end_reason = 'switched' where user_id = v_staff and ended_at is null;
  insert into private.support_sessions (user_id, company_id, grant_id, reason, ends_at) values (v_staff, p_company, g.id, v_reason, v_end);
  perform private.platform_log('support_entered', 'company', p_company::text, format('Entered %s as support', v_name),
                               jsonb_build_object('company_id', p_company, 'reason', v_reason, 'ends_at', v_end, 'grant', g.id));
  perform private.support_audit(p_company, 'support.entered', format('%s (Taviron support) came in', private.staff_name(v_staff)),
                                jsonb_build_object('reason', v_reason, 'ends_at', v_end));
  return v_end;
end;
$$;
revoke all on function public.platform_support_enter(uuid, text) from public, anon;
grant execute on function public.platform_support_enter(uuid, text) to authenticated;

-- Staff: leave the company being visited. Allowed even when the visit has already lapsed.
create or replace function public.platform_support_leave()
returns void language plpgsql security definer set search_path = '' as $$
declare
  s private.support_sessions;
begin
  if auth.uid() is null then return; end if;
  for s in update private.support_sessions set ended_at = now(), end_reason = 'left' where user_id = auth.uid() and ended_at is null returning * loop
    perform private.platform_log('support_left', 'company', s.company_id::text, 'Left the company', jsonb_build_object('company_id', s.company_id));
    perform private.support_audit(s.company_id, 'support.left', format('%s (Taviron support) left', private.staff_name(s.user_id)), '{}'::jsonb);
  end loop;
end;
$$;
revoke all on function public.platform_support_leave() from public, anon;
grant execute on function public.platform_support_leave() to authenticated;

-- Admin: remove someone from the team (never yourself, never the last Admin). Their visits end at once.
create or replace function public.platform_staff_remove(p_user uuid, p_note text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_admin uuid := private.require_platform_admin();
  v_level text;
begin
  if p_user = v_admin then raise exception 'You cannot remove yourself. Ask another Admin.' using errcode = 'P0001'; end if;
  select level into v_level from private.platform_admins where user_id = p_user and revoked_at is null for update;
  if v_level is null then raise exception 'That person is not on the team.' using errcode = 'P0002'; end if;
  if v_level = 'admin' and not exists (select 1 from private.platform_admins where level = 'admin' and revoked_at is null and user_id <> p_user) then
    raise exception 'The team needs at least one Admin.' using errcode = 'P0001';
  end if;
  update private.platform_admins set revoked_at = now(), revoke_note = left(coalesce(p_note, ''), 300) where user_id = p_user;
  update private.support_sessions set ended_at = now(), end_reason = 'staff_removed' where user_id = p_user and ended_at is null;
  perform private.platform_log('staff_removed', 'user', p_user::text, format('Removed %s from the team', private.staff_name(p_user)),
                               jsonb_build_object('level', v_level, 'note', left(coalesce(p_note, ''), 300)));
end;
$$;
revoke all on function public.platform_staff_remove(uuid, text) from public, anon;
grant execute on function public.platform_staff_remove(uuid, text) to authenticated;

-- 6. A visit never changes who can sign in or what they may do (security review 2026-11-06, H1) -----------------------
-- Staff work with the owner's permissions, but adding or changing members, roles and their permissions, sign-in setup
-- and provisioning, portal sign-ins, the company's two-step rule and the GPS feed key would let access outlive the
-- visit. A trigger on each of those tables refuses any change made from a visit, whichever function or API makes it.
create or replace function private.forbid_during_support_visit()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if private.support_company() is not null then
    raise exception 'Taviron support cannot change who can sign in to the company or what they may do. Ask an owner of the company.'
      using errcode = '42501';
  end if;
  return coalesce(new, old);
end;
$$;
revoke all on function private.forbid_during_support_visit() from public, anon, authenticated;

create trigger z_no_support_visit before insert or update or delete on public.company_memberships
  for each row execute function private.forbid_during_support_visit();
create trigger z_no_support_visit before insert or update or delete on public.role_permissions
  for each row execute function private.forbid_during_support_visit();
create trigger z_no_support_visit before insert or update or delete on public.portal_accounts
  for each row execute function private.forbid_during_support_visit();
create trigger z_no_support_visit before insert or update or delete on public.telematics_settings
  for each row execute function private.forbid_during_support_visit();
create trigger z_no_support_visit before insert or update or delete on private.account_setups
  for each row execute function private.forbid_during_support_visit();
create trigger z_no_support_visit before insert or update or delete on private.account_provisions
  for each row execute function private.forbid_during_support_visit();
create trigger z_no_support_visit before update of require_mfa on public.company_settings
  for each row execute function private.forbid_during_support_visit();
