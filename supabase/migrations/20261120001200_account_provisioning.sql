-- =============================================================================
-- Account provisioning and first sign-in (employees and customer-portal users) — docs/ACCOUNT_PROVISIONING.md.
--
-- Sign-in identity: a username. Supabase Auth signs people in with an email address, so a username account carries
-- the internal address <username>@users.mytaviron.com (src/lib/usernames.ts): never a mailbox, never sent anything.
-- A person's real email (optional) stays a contact detail on their employee or customer-contact record.
--
-- How an account is set up (the server holds the Auth admin key; nothing here can create an Auth user):
--   1. Staff reserve the username: account_provision_begin (idempotent per request key; usernames are unique).
--   2. The server creates the Auth user with a random temporary password and attaches it: account_provision_attach.
--   3. Staff give it access: an employee membership (add_company_member) or a customer-portal login
--      (portal_create_login), then account_setup_issue records that setup is required.
--   4. The person signs in with the username and the temporary password (or an emailed one-time link) and must choose
--      their own password. account_setup_complete accepts only when the stored password actually changed: the database
--      compares a SHA-256 fingerprint of the Auth password hash taken when the credential was issued (a hash of a hash;
--      the temporary password itself is never stored anywhere).
--
-- Enforcement in the database, not only the app: while setup is required (or the temporary credential expired), the
-- person has no company (private.current_company_id() is null, so every company table and function refuses) and no
-- portal (private.portal_me refuses). Reissuing replaces the temporary password and starts setup again.
--
-- Safety: staff can issue credentials only for username accounts that have no access anywhere else (no other company,
-- no other company's portal, not a platform administrator), only owners for owners, never for themselves, never in a
-- demo company. Staff never see or set a permanent password. Every step is audited (audit_events + security_events),
-- never with a password, link or token.
--
-- Depends on 20261120000700 (portal), 20261120000900 (security_events), 20261120001100 (current_company_id, portal_me).
-- Rollback: supabase/rollbacks/20261120001200_account_provisioning.down.sql
-- =============================================================================

create table private.account_setups (
  user_id                uuid primary key references auth.users (id) on delete cascade,
  company_id             uuid not null references public.companies (id) on delete cascade,
  kind                   text not null check (kind in ('employee', 'portal')),
  username               text not null,
  status                 text not null default 'setup_required' check (status in ('setup_required', 'complete')),
  credential_fingerprint text not null check (credential_fingerprint ~ '^[0-9a-f]{64}$'),
  issued_at              timestamptz not null default now(),
  issued_by              uuid references auth.users (id) on delete set null,
  expires_at             timestamptz not null,
  issue_count            integer not null default 1 check (issue_count > 0),
  completed_at           timestamptz,
  created_at             timestamptz not null default now(),
  check ((status = 'complete') = (completed_at is not null))
);
create index account_setups_company on private.account_setups (company_id);
alter table private.account_setups enable row level security;

create table private.account_provisions (
  request_key uuid primary key,
  company_id  uuid not null references public.companies (id) on delete cascade,
  kind        text not null check (kind in ('employee', 'portal')),
  username    text not null unique,
  user_id     uuid references auth.users (id) on delete cascade,
  created_by  uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now()
);
alter table private.account_provisions enable row level security;

-- -----------------------------------------------------------------------------
-- Helpers
-- -----------------------------------------------------------------------------

/** The internal sign-in address of a valid username (same rule as src/lib/usernames.ts), or null. */
create or replace function private.username_address(p_username text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when v ~ '^[a-z0-9][a-z0-9.-]{1,30}[a-z0-9]$' and v !~ '\.\.' then v || '@users.mytaviron.com' end
  from (select lower(btrim(coalesce(p_username, ''))) as v) x;
$$;

/** SHA-256 of the person's stored password hash: tells whether the password changed, reveals nothing about it. */
create or replace function private.password_fingerprint(p_user uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select encode(sha256(convert_to(coalesce(u.encrypted_password, ''), 'UTF8')), 'hex') from auth.users u where u.id = p_user;
$$;
revoke all on function private.password_fingerprint(uuid) from public, anon, authenticated;

/** Staff permission for a kind of account, in the caller's current company (raises otherwise). */
create or replace function private.provision_staff(p_kind text)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
begin
  if p_kind = 'employee' then perform private.require_permission('users.manage');
  elsif p_kind = 'portal' then perform private.require_permission('customers.edit');
  else raise exception 'Unknown account kind.' using errcode = '22023';
  end if;
  return v_company;
end;
$$;
revoke all on function private.provision_staff(text) from public, anon, authenticated;

/** Audit row for a company (also while the subject has no current company). Never a secret in p_detail. */
create or replace function private.account_audit(p_company uuid, p_action text, p_user uuid, p_summary text, p_detail jsonb)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.audit_events (company_id, actor_id, action, entity_type, entity_id, summary, details)
  values (p_company, auth.uid(), p_action, 'account', p_user, left(coalesce(p_summary, ''), 300), coalesce(p_detail, '{}'::jsonb));
  insert into private.security_events (user_id, event, detail)
  values (p_user, p_action, coalesce(p_detail, '{}'::jsonb) || jsonb_build_object('company_id', p_company, 'by', auth.uid()));
$$;
revoke all on function private.account_audit(uuid, text, uuid, text, jsonb) from public, anon, authenticated;

/** Raise unless staff of the caller's company may issue credentials for this account (see header). */
create or replace function private.account_issue_allowed(p_user uuid, p_kind text)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.provision_staff(p_kind);
  v_email text;
begin
  if p_user is null or p_user = auth.uid() then raise exception 'Use My profile to change your own password.' using errcode = '42501'; end if;
  if exists (select 1 from public.companies where id = v_company and is_demo) then
    raise exception 'Demo companies do not create sign-ins (nothing real is created from a demo).' using errcode = '42501';
  end if;
  select email into v_email from auth.users where id = p_user;
  if v_email is null or lower(v_email) not like '%@users.mytaviron.com' then
    raise exception 'Only username sign-ins are set up here. People who sign in with their own email reset it from the sign-in page.' using errcode = '42501';
  end if;
  if p_kind = 'employee' and not exists (select 1 from public.company_memberships m where m.company_id = v_company and m.user_id = p_user) then
    raise exception 'This person is not in your company.' using errcode = 'P0002';
  end if;
  if p_kind = 'portal' and not exists (select 1 from public.portal_accounts a where a.company_id = v_company and a.user_id = p_user) then
    raise exception 'This portal sign-in is not in your company.' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.company_memberships m where m.user_id = p_user and m.company_id <> v_company)
     or exists (select 1 from public.portal_accounts a where a.user_id = p_user and a.company_id <> v_company)
     or exists (select 1 from private.platform_admins pa where pa.user_id = p_user and pa.revoked_at is null)
     or (p_kind = 'employee' and exists (select 1 from public.portal_accounts a where a.user_id = p_user))
     or (p_kind = 'portal' and exists (select 1 from public.company_memberships m where m.user_id = p_user)) then
    raise exception 'This sign-in is also used elsewhere, so it cannot be reset from here.' using errcode = '42501';
  end if;
  if exists (select 1 from public.company_memberships m where m.company_id = v_company and m.user_id = p_user and m.role = 'owner')
     and private.current_app_role() is distinct from 'owner' then
    raise exception 'Only an owner can reset an owner''s sign-in.' using errcode = '42501';
  end if;
  return v_company;
end;
$$;
revoke all on function private.account_issue_allowed(uuid, text) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Gates: no company and no portal while setup is required
-- -----------------------------------------------------------------------------

create or replace function private.setup_pending()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from private.account_setups s where s.user_id = auth.uid() and s.status = 'setup_required');
$$;
revoke all on function private.setup_pending() from public, anon, authenticated;

create or replace function private.current_company_id()
 returns uuid
 language sql
 stable
 security definer
 set search_path to ''
as $$
  -- One query, cheapest test first (it runs inside most row-level security policies). Same membership choice as
  -- private.current_company_id_any(). No company below aal2 for enrolled/required two-step (20261120001100), and none
  -- while first sign-in setup is pending (20261120001200).
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
    order by (m.company_id = p.active_company_id) desc nulls last, m.created_at, m.company_id
    limit 1) as company_id) x
$$;

create or replace function private.portal_me(p_slug text)
 returns public.portal_accounts
 language plpgsql
 stable
 security definer
 set search_path to ''
as $$
declare
  v public.portal_accounts%rowtype;
  p private.portal_previews%rowtype;
begin
  if auth.uid() is null or private.setup_pending() then
    raise exception 'Not available.' using errcode = '42501';
  end if;
  select a.* into v
  from public.portal_accounts a join public.companies c on c.id = a.company_id
  where c.slug = p_slug and a.user_id = auth.uid() and a.status = 'active'
    and exists (select 1 from public.customers cu where cu.company_id = a.company_id and cu.id = a.customer_id and cu.active);
  if found and private.portal_open(v.company_id) then
    return v;
  end if;
  select pv.* into p from private.portal_previews pv join public.companies c on c.id = pv.company_id
  where pv.admin_id = auth.uid() and c.slug = p_slug and c.is_demo and pv.expires_at > now();
  if found and private.is_platform_admin() and (private.aal2() or not private.platform_mfa_enforced()) and private.portal_open(p.company_id)
     and exists (select 1 from public.customers cu where cu.company_id = p.company_id and cu.id = p.customer_id and cu.active) then
    select a.* into v from public.portal_accounts a
    where a.company_id = p.company_id and a.customer_id = p.customer_id and a.status = 'active' and a.user_id is null
      and lower(a.email) like 'preview-%@portal-preview.invalid'
    limit 1;
    if found then
      return v;
    end if;
  end if;
  raise exception 'Not available.' using errcode = '42501';
end;
$$;

-- -----------------------------------------------------------------------------
-- Staff: reserve a username, attach the Auth user, issue setup
-- -----------------------------------------------------------------------------

create or replace function public.account_username_available(p_username text, p_kind text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_address text := private.username_address(p_username);
begin
  perform private.provision_staff(p_kind);
  if v_address is null then
    return jsonb_build_object('valid', false, 'available', false);
  end if;
  return jsonb_build_object('valid', true, 'available',
    not exists (select 1 from auth.users u where lower(u.email) = v_address)
    and not exists (select 1 from private.account_provisions r where r.username = lower(btrim(p_username))));
end;
$$;

/** Reserve a username for a new sign-in. The same request key resumes (a retry never creates a second account). */
create or replace function public.account_provision_begin(p_request_key uuid, p_kind text, p_username text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.provision_staff(p_kind);
  v_username text := lower(btrim(coalesce(p_username, '')));
  v_address text := private.username_address(p_username);
  r private.account_provisions%rowtype;
begin
  if p_request_key is null then raise exception 'Missing request key.' using errcode = '22023'; end if;
  if exists (select 1 from public.companies where id = v_company and is_demo) then
    raise exception 'Demo companies do not create sign-ins (nothing real is created from a demo).' using errcode = '42501';
  end if;
  select * into r from private.account_provisions where request_key = p_request_key;
  if found then
    if r.company_id <> v_company or r.created_by is distinct from auth.uid() or r.kind <> p_kind or r.username <> v_username then
      raise exception 'This request was already used.' using errcode = '42501';
    end if;
    return jsonb_build_object('username', r.username, 'address', private.username_address(r.username), 'user_id', r.user_id, 'resumed', true,
      'setup', (select status from private.account_setups where user_id = r.user_id));
  end if;
  if v_address is null then
    raise exception 'Usernames are 3–32 letters, digits, dots or hyphens, starting and ending with a letter or digit.' using errcode = '22023';
  end if;
  if exists (select 1 from auth.users u where lower(u.email) = v_address) or exists (select 1 from private.account_provisions where username = v_username) then
    raise exception 'That username is taken. Choose another.' using errcode = '23505';
  end if;
  if (select count(*) from private.account_provisions where created_by = auth.uid() and created_at > now() - interval '1 hour') >= 60 then
    raise exception 'Too many new sign-ins in the last hour. Try again later.' using errcode = '54000';
  end if;
  insert into private.account_provisions (request_key, company_id, kind, username, created_by)
  values (p_request_key, v_company, p_kind, v_username, auth.uid());
  return jsonb_build_object('username', v_username, 'address', v_address, 'user_id', null, 'resumed', false);
exception when unique_violation then
  raise exception 'That username is taken. Choose another.' using errcode = '23505';
end;
$$;

/** Attach the Auth user the server created for this reservation (its address must be the username's). */
create or replace function public.account_provision_attach(p_request_key uuid, p_user uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  r private.account_provisions%rowtype;
begin
  select * into r from private.account_provisions where request_key = p_request_key for update;
  if not found or r.created_by is distinct from auth.uid() then raise exception 'Request not found.' using errcode = 'P0002'; end if;
  perform private.provision_staff(r.kind);
  if r.company_id <> private.current_company_id() then raise exception 'Request not found.' using errcode = 'P0002'; end if;
  if r.user_id is not null then
    if r.user_id <> p_user then raise exception 'This request already has a sign-in.' using errcode = '42501'; end if;
    return;
  end if;
  if not exists (select 1 from auth.users u where u.id = p_user and lower(u.email) = private.username_address(r.username)) then
    raise exception 'The sign-in does not match the reserved username.' using errcode = '42501';
  end if;
  update private.account_provisions set user_id = p_user where request_key = p_request_key;
end;
$$;

/** Check before the server sets a temporary password (raises when not allowed). */
create or replace function public.account_setup_check(p_user uuid, p_kind text)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.account_issue_allowed(p_user, p_kind);
end;
$$;

/**
 * Record that setup is required, after the server set a new temporary password: fingerprint of the stored password
 * now, expiry (1 hour to 14 days). Replaces any earlier issue; the earlier temporary password no longer works because
 * the server replaced it.
 */
create or replace function public.account_setup_issue(p_user uuid, p_kind text, p_hours integer, p_method text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.account_issue_allowed(p_user, p_kind);
  v_hours integer := least(greatest(coalesce(p_hours, 168), 1), 336);
  v_username text;
  v_count integer;
begin
  if p_method is null or p_method not in ('print', 'copy', 'email', 'reset') then
    raise exception 'Unknown delivery method.' using errcode = '22023';
  end if;
  select split_part(lower(email), '@', 1) into v_username from auth.users where id = p_user;
  insert into private.account_setups (user_id, company_id, kind, username, status, credential_fingerprint, issued_at, issued_by, expires_at, issue_count)
  values (p_user, v_company, p_kind, v_username, 'setup_required', private.password_fingerprint(p_user), now(), auth.uid(),
          now() + make_interval(hours => v_hours), 1)
  on conflict (user_id) do update set company_id = excluded.company_id, kind = excluded.kind, username = excluded.username,
    status = 'setup_required', credential_fingerprint = excluded.credential_fingerprint, issued_at = now(), issued_by = auth.uid(),
    expires_at = excluded.expires_at, issue_count = private.account_setups.issue_count + 1, completed_at = null
  returning issue_count into v_count;
  perform private.account_audit(v_company, case when v_count = 1 then 'account.setup_issued' else 'account.setup_reissued' end, p_user,
    format('Sign-in setup %s for %s (%s)', case when v_count = 1 then 'issued' else 'reissued' end, v_username, p_method),
    jsonb_build_object('kind', p_kind, 'method', p_method, 'expires_hours', v_hours, 'issue', v_count));
  return jsonb_build_object('username', v_username, 'expires_at', now() + make_interval(hours => v_hours), 'issue', v_count);
end;
$$;

/** Delivery outcome for the audit trail (no link, no password): e.g. email accepted by the provider or failed. */
create or replace function public.account_delivery_record(p_user uuid, p_kind text, p_channel text, p_outcome text, p_reference text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.provision_staff(p_kind);
begin
  if not exists (select 1 from private.account_setups s where s.user_id = p_user and s.company_id = v_company) then
    raise exception 'Sign-in not found.' using errcode = 'P0002';
  end if;
  if p_channel not in ('email', 'print', 'copy') or p_outcome not in ('accepted', 'failed', 'prepared') then
    raise exception 'Unknown delivery outcome.' using errcode = '22023';
  end if;
  perform private.account_audit(v_company, 'account.delivery_' || p_outcome, p_user, format('Sign-in instructions %s (%s)', p_outcome, p_channel),
    jsonb_build_object('channel', p_channel, 'reference', left(coalesce(p_reference, ''), 120)));
end;
$$;

-- -----------------------------------------------------------------------------
-- The person: what setup is required, and completing it
-- -----------------------------------------------------------------------------

create or replace function public.my_account_setup()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select jsonb_build_object('required', s.status = 'setup_required', 'expired', s.status = 'setup_required' and s.expires_at < now(),
      'kind', s.kind, 'username', s.username, 'expires_at', s.expires_at,
      'company', coalesce(nullif(cs.company_name, ''), c.name), 'slug', c.slug)
    from private.account_setups s join public.companies c on c.id = s.company_id
    left join public.company_settings cs on cs.company_id = c.id
    where s.user_id = auth.uid()), jsonb_build_object('required', false));
$$;

/** Accept only when the stored password differs from the issued temporary one (the server never marks it for you). */
create or replace function public.account_setup_complete()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  s private.account_setups%rowtype;
begin
  select * into s from private.account_setups where user_id = auth.uid() for update;
  if not found or s.status <> 'setup_required' then
    return jsonb_build_object('completed', true, 'kind', coalesce(s.kind, 'employee'));
  end if;
  if s.expires_at < now() then
    raise exception 'Your temporary sign-in has expired. Ask your administrator for a new one.' using errcode = '22023';
  end if;
  if private.password_fingerprint(auth.uid()) = s.credential_fingerprint then
    raise exception 'Choose a new password first.' using errcode = '22023';
  end if;
  update private.account_setups set status = 'complete', completed_at = now() where user_id = auth.uid();
  perform private.account_audit(s.company_id, 'account.setup_completed', auth.uid(), format('Sign-in setup completed by %s', s.username),
    jsonb_build_object('kind', s.kind));
  return jsonb_build_object('completed', true, 'kind', s.kind);
end;
$$;

-- -----------------------------------------------------------------------------
-- Staff: overview and access changes
-- -----------------------------------------------------------------------------

/** Username sign-ins of the caller's company (employees with users.manage; portal logins with customers.edit). */
create or replace function public.company_account_states(p_kind text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.provision_staff(p_kind);
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object('user_id', s.user_id, 'username', s.username, 'status', s.status,
      'expired', s.status = 'setup_required' and s.expires_at < now(), 'issued_at', s.issued_at, 'expires_at', s.expires_at,
      'issue_count', s.issue_count, 'completed_at', s.completed_at, 'last_sign_in_at', u.last_sign_in_at,
      'banned', coalesce(u.banned_until > now(), false)) order by s.username)
    from private.account_setups s join auth.users u on u.id = s.user_id
    where s.company_id = v_company and s.kind = p_kind), '[]'::jsonb);
end;
$$;

/** Recent security events of one of the company's username sign-ins (no secrets are ever recorded). */
create or replace function public.account_events(p_user uuid, p_kind text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.provision_staff(p_kind);
begin
  if not exists (select 1 from private.account_setups s where s.user_id = p_user and s.company_id = v_company and s.kind = p_kind) then
    raise exception 'Sign-in not found.' using errcode = 'P0002';
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object('at', e.at, 'event', e.event, 'method', e.detail ->> 'method', 'channel', e.detail ->> 'channel') order by e.at desc)
    from (select * from private.security_events e where e.user_id = p_user and (e.detail ->> 'company_id') = v_company::text order by e.at desc limit 30) e), '[]'::jsonb);
end;
$$;

/**
 * Should the server block this sign-in in Auth (sessions stop refreshing) after access was removed here? Only when it
 * has no other access anywhere; never for people who also work elsewhere.
 */
create or replace function public.account_block_allowed(p_user uuid, p_kind text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.provision_staff(p_kind);
begin
  if p_user is null or p_user = auth.uid() then return false; end if;
  if p_kind = 'employee' and not exists (select 1 from public.company_memberships m where m.company_id = v_company and m.user_id = p_user) then return false; end if;
  if p_kind = 'portal' and not exists (select 1 from public.portal_accounts a where a.company_id = v_company and a.user_id = p_user) then return false; end if;
  return not exists (select 1 from public.company_memberships m where m.user_id = p_user and m.active)
     and not exists (select 1 from public.portal_accounts a where a.user_id = p_user and a.status = 'active')
     and not exists (select 1 from private.platform_admins pa where pa.user_id = p_user and pa.revoked_at is null);
end;
$$;

/** Audit an access change the server made in Auth or here (deactivated, reactivated, sessions blocked/unblocked). */
create or replace function public.account_access_record(p_user uuid, p_kind text, p_action text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.provision_staff(p_kind);
begin
  if p_action not in ('deactivated', 'reactivated', 'sessions_blocked', 'sessions_unblocked', 'revoked') then
    raise exception 'Unknown action.' using errcode = '22023';
  end if;
  if (p_kind = 'employee' and not exists (select 1 from public.company_memberships m where m.company_id = v_company and m.user_id = p_user))
     or (p_kind = 'portal' and not exists (select 1 from public.portal_accounts a where a.company_id = v_company and a.user_id = p_user)) then
    raise exception 'Sign-in not found.' using errcode = 'P0002';
  end if;
  perform private.account_audit(v_company, 'account.' || p_action, p_user, format('Sign-in %s', replace(p_action, '_', ' ')), jsonb_build_object('kind', p_kind));
end;
$$;

-- -----------------------------------------------------------------------------
-- Customer portal: username logins for a customer's contacts
-- -----------------------------------------------------------------------------

/**
 * Create the portal login for a reserved username (after the server attached the Auth user): one customer, an existing
 * contact or a new one (name required; no duplicate contact by email or name). The login is active but unusable until
 * setup is completed. Refused in demo companies and while the portal is not open.
 */
create or replace function public.portal_create_login(p_request_key uuid, p_customer uuid, p_contact uuid, p_contact_name text, p_contact_email text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.provision_staff('portal');
  r private.account_provisions%rowtype;
  v_contact uuid := p_contact;
  v_name text := btrim(coalesce(p_contact_name, ''));
  v_email text := lower(btrim(coalesce(p_contact_email, '')));
  v_id uuid;
begin
  if exists (select 1 from public.companies where id = v_company and is_demo) then
    raise exception 'Demo companies do not create sign-ins (preview the portal from the Testing Lab).' using errcode = '42501';
  end if;
  if not private.portal_open(v_company) then
    raise exception 'Turn the customer portal on before creating customer sign-ins.' using errcode = 'P0001';
  end if;
  select * into r from private.account_provisions where request_key = p_request_key and kind = 'portal' for update;
  if not found or r.company_id <> v_company or r.created_by is distinct from auth.uid() or r.user_id is null then
    raise exception 'Request not found.' using errcode = 'P0002';
  end if;
  select id into v_id from public.portal_accounts where company_id = v_company and user_id = r.user_id;
  if found then return v_id; end if;  -- a retry
  if not exists (select 1 from public.customers where company_id = v_company and id = p_customer and active) then
    raise exception 'Customer not found.' using errcode = 'P0002';
  end if;
  if v_email <> '' and (v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or length(v_email) > 254 or v_email like '%@users.mytaviron.com') then
    raise exception 'Enter a valid contact email, or leave it empty.' using errcode = '22023';
  end if;
  if v_contact is not null then
    if not exists (select 1 from public.customer_contacts where company_id = v_company and id = v_contact and customer_id = p_customer) then
      raise exception 'Contact not found for this customer.' using errcode = 'P0002';
    end if;
  else
    if length(v_name) < 2 or length(v_name) > 120 then raise exception 'Enter the contact''s name.' using errcode = '22023'; end if;
    select id into v_contact from public.customer_contacts
    where company_id = v_company and customer_id = p_customer
      and ((v_email <> '' and lower(email) = v_email) or lower(btrim(name)) = lower(v_name))
    order by (v_email <> '' and lower(email) = v_email) desc limit 1;
    if v_contact is null then
      insert into public.customer_contacts (company_id, customer_id, name, email)
      values (v_company, p_customer, v_name, nullif(v_email, '')) returning id into v_contact;
    end if;
  end if;
  if exists (select 1 from public.portal_accounts a where a.company_id = v_company and a.contact_id = v_contact and a.status <> 'revoked' and a.user_id is not null) then
    raise exception 'This contact already has a portal sign-in. Reissue it instead.' using errcode = '23505';
  end if;
  insert into public.portal_accounts (company_id, customer_id, contact_id, email, user_id, status, invited_by, accepted_at)
  values (v_company, p_customer, v_contact, private.username_address(r.username), r.user_id, 'active', auth.uid(), now())
  returning id into v_id;
  perform private.account_audit(v_company, 'account.created', r.user_id, format('Portal sign-in %s created', r.username),
    jsonb_build_object('kind', 'portal', 'customer_id', p_customer, 'contact_id', v_contact));
  return v_id;
end;
$$;

/** Re-enable a revoked username portal login (customers.edit); setup is issued again by the server afterwards. */
create or replace function public.portal_reactivate(p_account uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.provision_staff('portal');
  v public.portal_accounts%rowtype;
begin
  update public.portal_accounts set status = 'active', revoked_at = null, revoked_by = null
  where id = p_account and company_id = v_company and status = 'revoked' and user_id is not null and lower(email) like '%@users.mytaviron.com'
    and not exists (select 1 from public.portal_accounts o where o.company_id = v_company and o.id <> p_account and lower(o.email) = lower(portal_accounts.email) and o.status <> 'revoked')
  returning * into v;
  if not found then raise exception 'Portal sign-in not found or not revoked.' using errcode = 'P0002'; end if;
  perform private.account_audit(v_company, 'account.reactivated', v.user_id, 'Portal sign-in re-enabled', jsonb_build_object('kind', 'portal'));
  return v.user_id;
end;
$$;

/** Audit an employee account creation (the membership itself is made by add_company_member). */
create or replace function public.account_employee_created(p_request_key uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.provision_staff('employee');
  r private.account_provisions%rowtype;
  v_role text;
begin
  select * into r from private.account_provisions where request_key = p_request_key and kind = 'employee';
  if not found or r.company_id <> v_company or r.user_id is null then raise exception 'Request not found.' using errcode = 'P0002'; end if;
  select role::text into v_role from public.company_memberships where company_id = v_company and user_id = r.user_id;
  if v_role is null then raise exception 'The sign-in has no role in your company yet.' using errcode = 'P0001'; end if;
  if exists (select 1 from public.audit_events where company_id = v_company and action = 'account.created' and entity_id = r.user_id) then return; end if;
  perform private.account_audit(v_company, 'account.created', r.user_id, format('Employee sign-in %s created as %s', r.username, v_role),
    jsonb_build_object('kind', 'employee', 'role', v_role));
end;
$$;

revoke all on function private.username_address(text), private.setup_pending() from public, anon;
grant execute on function private.username_address(text) to authenticated;

revoke all on function public.account_username_available(text, text), public.account_provision_begin(uuid, text, text),
  public.account_provision_attach(uuid, uuid), public.account_setup_check(uuid, text), public.account_setup_issue(uuid, text, integer, text),
  public.account_delivery_record(uuid, text, text, text, text), public.my_account_setup(), public.account_setup_complete(),
  public.company_account_states(text), public.account_events(uuid, text), public.account_block_allowed(uuid, text),
  public.portal_create_login(uuid, uuid, uuid, text, text), public.portal_reactivate(uuid), public.account_employee_created(uuid),
  public.account_access_record(uuid, text, text)
  from public, anon;
grant execute on function public.account_username_available(text, text), public.account_provision_begin(uuid, text, text),
  public.account_provision_attach(uuid, uuid), public.account_setup_check(uuid, text), public.account_setup_issue(uuid, text, integer, text),
  public.account_delivery_record(uuid, text, text, text, text), public.my_account_setup(), public.account_setup_complete(),
  public.company_account_states(text), public.account_events(uuid, text), public.account_block_allowed(uuid, text),
  public.portal_create_login(uuid, uuid, uuid, text, text), public.portal_reactivate(uuid), public.account_employee_created(uuid),
  public.account_access_record(uuid, text, text)
  to authenticated;
