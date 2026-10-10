-- =============================================================================
-- Accounts, company onboarding and early access (N9).
--
-- Design (docs/IMPLEMENTATION_PLAN.md §5i):
--   * Early access is a separate component in the private schema (not exposed
--     through the API): codes are stored only as SHA-256 hashes with a label,
--     maximum uses, expiry and revocation; redemptions; and attempts used for
--     rate limiting. Code checks for new accounts run with the service role
--     from the server; Supabase Auth keeps handling authentication, and public
--     sign-up stays disabled there.
--   * A new account reserves one use of a code. After the email is verified,
--     complete_company_onboarding creates the company, the owner membership and
--     the active company in one transaction (repeat → same company).
--   * Existing accounts can create another company with a code; people already
--     registered can be invited into a company; switch_company changes the
--     active company among the caller's own memberships.
--   * Only owners can grant or remove the Owner role.
-- Additive. To reverse: drop the functions defined here, the three
-- private.early_access_* / access_attempts tables, and restore
-- add_company_member / set_user_access from 20261011000200.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Early-access records (private schema: no API access)
-- -----------------------------------------------------------------------------
create table private.early_access_codes (
  id            uuid primary key default gen_random_uuid(),
  code_hash     text not null unique check (code_hash ~ '^[0-9a-f]{64}$'),
  label         text not null check (length(trim(label)) between 1 and 120),
  max_uses      integer not null check (max_uses between 1 and 1000),
  expires_at    timestamptz not null,
  created_at    timestamptz not null default now(),
  created_by    text not null default current_user,
  revoked_at    timestamptz,
  revoke_reason text not null default '',
  constraint early_access_codes_revoke check ((revoked_at is null) = (revoke_reason = ''))
);

create table private.early_access_redemptions (
  id           uuid primary key default gen_random_uuid(),
  code_id      uuid not null references private.early_access_codes (id),
  user_id      uuid not null references auth.users (id) on delete cascade,
  company_name text not null check (length(trim(company_name)) between 2 and 120),
  -- Idempotency: one request key → one reservation / company.
  request_key  uuid not null unique,
  status       text not null check (status in ('reserved', 'completed')),
  company_id   uuid references public.companies (id) on delete set null,
  created_at   timestamptz not null default now(),
  completed_at timestamptz,
  constraint early_access_redemptions_done check ((status = 'completed') = (completed_at is not null))
);
-- At most one company waiting per account.
create unique index early_access_redemptions_pending on private.early_access_redemptions (user_id) where status = 'reserved';
create index early_access_redemptions_code on private.early_access_redemptions (code_id);

-- Attempts for rate limiting, keyed by a hash of the IP address, the email
-- address or the user id (no raw addresses are stored).
create table private.access_attempts (
  id         bigint generated always as identity primary key,
  scope      text not null check (scope in ('ip', 'email', 'user')),
  key_hash   text not null,
  success    boolean not null,
  created_at timestamptz not null default now()
);
create index access_attempts_lookup on private.access_attempts (scope, key_hash, created_at);

revoke all on private.early_access_codes, private.early_access_redemptions, private.access_attempts from public, anon, authenticated;

-- Uses still available: reservations and completed companies both count.
create or replace function private.early_access_code_state(p_code_hash text, p_lock boolean default false)
returns table (code_id uuid, valid boolean, reason text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_c    private.early_access_codes%rowtype;
  v_used integer;
begin
  if p_lock then
    select * into v_c from private.early_access_codes where code_hash = p_code_hash for update;
  else
    select * into v_c from private.early_access_codes where code_hash = p_code_hash;
  end if;
  if not found then return query select null::uuid, false, 'unknown'; return; end if;
  if v_c.revoked_at is not null then return query select v_c.id, false, 'revoked'; return; end if;
  if v_c.expires_at <= now() then return query select v_c.id, false, 'expired'; return; end if;
  select count(*) into v_used from private.early_access_redemptions r where r.code_id = v_c.id;
  if v_used >= v_c.max_uses then return query select v_c.id, false, 'used_up'; return; end if;
  return query select v_c.id, true, 'ok';
end;
$$;

-- Too many failed attempts in the last 15 minutes for a key?
create or replace function private.access_rate_limited(p_scope text, p_key_hash text, p_limit integer)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select count(*) >= p_limit
  from private.access_attempts
  where scope = p_scope and key_hash = p_key_hash and not success and created_at > now() - interval '15 minutes'
$$;

-- -----------------------------------------------------------------------------
-- 2. Server-side steps of sign-up (service role only)
-- -----------------------------------------------------------------------------
-- Check a code before creating an account. Records the attempt and enforces
-- rate limits (10 failures per IP, 5 per email address in 15 minutes). Never
-- raises for a bad code, so the attempt is kept.
create or replace function public.early_access_check(p_code_hash text, p_ip_hash text, p_email_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_state record;
  v_ip    text := coalesce(nullif(p_ip_hash, ''), 'unknown');
  v_email text := coalesce(nullif(p_email_hash, ''), 'unknown');
begin
  if private.access_rate_limited('ip', v_ip, 10) or private.access_rate_limited('email', v_email, 5) then
    return jsonb_build_object('ok', false, 'reason', 'rate_limited');
  end if;
  select * into v_state from private.early_access_code_state(coalesce(p_code_hash, ''));
  insert into private.access_attempts (scope, key_hash, success) values ('ip', v_ip, v_state.valid), ('email', v_email, v_state.valid);
  return jsonb_build_object('ok', v_state.valid, 'reason', v_state.reason);
end;
$$;

-- Reserve one use of a code for a newly created (unverified) account.
-- Idempotent per request key; serialized per code by a row lock.
create or replace function public.early_access_reserve(p_code_hash text, p_user_id uuid, p_company_name text, p_request_key uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_r     private.early_access_redemptions%rowtype;
  v_state record;
  v_name  text := trim(coalesce(p_company_name, ''));
begin
  select * into v_r from private.early_access_redemptions where request_key = p_request_key;
  if found then
    if v_r.user_id <> p_user_id then return jsonb_build_object('ok', false, 'reason', 'conflict'); end if;
    return jsonb_build_object('ok', true, 'redemption_id', v_r.id, 'created', false);
  end if;
  if length(v_name) not between 2 and 120 then return jsonb_build_object('ok', false, 'reason', 'company_name'); end if;
  select * into v_state from private.early_access_code_state(coalesce(p_code_hash, ''), true);
  if not v_state.valid then return jsonb_build_object('ok', false, 'reason', v_state.reason); end if;
  if exists (select 1 from private.early_access_redemptions where user_id = p_user_id and status = 'reserved') then
    return jsonb_build_object('ok', false, 'reason', 'pending');
  end if;
  insert into private.early_access_redemptions (code_id, user_id, company_name, request_key, status)
  values (v_state.code_id, p_user_id, v_name, p_request_key, 'reserved')
  returning * into v_r;
  return jsonb_build_object('ok', true, 'redemption_id', v_r.id, 'created', true);
end;
$$;

-- Was this sign-up request already processed (a repeated submit)? Read-only.
create or replace function public.early_access_request(p_request_key uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select jsonb_build_object('user_id', r.user_id, 'status', r.status)
                   from private.early_access_redemptions r where r.request_key = p_request_key), '{}'::jsonb)
$$;

-- Operator: create a code (the caller generates the code and passes its hash).
create or replace function public.early_access_create_code(p_code_hash text, p_label text, p_max_uses integer, p_expires_at timestamptz)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_expires_at <= now() then raise exception 'The expiry must be in the future.'; end if;
  insert into private.early_access_codes (code_hash, label, max_uses, expires_at)
  values (p_code_hash, trim(p_label), p_max_uses, p_expires_at)
  returning id into v_id;
  return v_id;
end;
$$;

-- Operator: list codes (never the codes themselves).
create or replace function public.early_access_list_codes()
returns table (id uuid, label text, max_uses integer, used integer, expires_at timestamptz, revoked_at timestamptz, revoke_reason text, created_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select c.id, c.label, c.max_uses,
         (select count(*)::int from private.early_access_redemptions r where r.code_id = c.id),
         c.expires_at, c.revoked_at, c.revoke_reason, c.created_at
  from private.early_access_codes c
  order by c.created_at desc
$$;

-- Operator: revoke a code. Companies already created are not affected;
-- pending sign-ups with this code can no longer create their company.
create or replace function public.early_access_revoke_code(p_code_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if length(trim(coalesce(p_reason, ''))) = 0 then raise exception 'Enter a reason.'; end if;
  update private.early_access_codes set revoked_at = now(), revoke_reason = trim(p_reason)
  where id = p_code_id and revoked_at is null;
  if not found then raise exception 'Code not found or already revoked.'; end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- 3. Creating a company for the signed-in user
-- -----------------------------------------------------------------------------
-- Company + owner membership + active company, in the caller's transaction.
create or replace function private.provision_company(p_user_id uuid, p_name text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_base text := trim(both '-' from left(regexp_replace(lower(p_name), '[^a-z0-9]+', '-', 'g'), 40));
  v_slug text;
  v_id   uuid;
begin
  loop
    v_slug := coalesce(nullif(v_base, ''), 'company') || '-' || substr(md5(gen_random_uuid()::text), 1, 6);
    exit when not exists (select 1 from public.companies where slug = v_slug);
  end loop;
  v_id := private.create_company(p_name, v_slug);
  insert into public.company_memberships (company_id, user_id, role, active) values (v_id, p_user_id, 'owner', true);
  update public.profiles set active_company_id = v_id where id = p_user_id;
  return v_id;
end;
$$;

-- What the signed-in user still has to do: a pending company from sign-up.
create or replace function public.my_onboarding()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'email_verified', (select u.email_confirmed_at is not null from auth.users u where u.id = auth.uid()),
    'pending_company', (select r.company_name from private.early_access_redemptions r
                        where r.user_id = auth.uid() and r.status = 'reserved'),
    'membership_count', (select count(*) from public.company_memberships m
                         where m.user_id = auth.uid() and m.active and m.role is not null))
$$;

-- Finish sign-up: create the reserved company. Repeating returns the same company.
create or replace function public.complete_company_onboarding(p_company_name text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := auth.uid();
  v_r     private.early_access_redemptions%rowtype;
  v_code  private.early_access_codes%rowtype;
  v_name  text;
  v_id    uuid;
begin
  if v_uid is null then raise exception 'Sign in first.' using errcode = '42501'; end if;
  if not exists (select 1 from auth.users where id = v_uid and email_confirmed_at is not null) then
    raise exception 'Confirm your email address first (check your inbox).' using errcode = '42501';
  end if;
  select * into v_r from private.early_access_redemptions where user_id = v_uid and status = 'reserved' for update;
  if not found then
    select * into v_r from private.early_access_redemptions
    where user_id = v_uid and status = 'completed' and company_id is not null order by completed_at desc limit 1;
    if found then
      return jsonb_build_object('company_id', v_r.company_id, 'created', false,
                                'name', (select name from public.companies where id = v_r.company_id));
    end if;
    raise exception 'There is no company waiting to be created for this account.';
  end if;
  select * into v_code from private.early_access_codes where id = v_r.code_id;
  if v_code.revoked_at is not null then
    raise exception 'The access code used for this account was revoked. Contact us for a new one.' using errcode = '42501';
  end if;
  v_name := trim(coalesce(nullif(trim(p_company_name), ''), v_r.company_name));
  if length(v_name) not between 2 and 120 then raise exception 'Enter the company name (2 to 120 characters).'; end if;

  v_id := private.provision_company(v_uid, v_name);
  update private.early_access_redemptions set status = 'completed', company_id = v_id, company_name = v_name, completed_at = now()
  where id = v_r.id;
  perform private.log_event('company.created', 'company', v_id, format('Company %s created by its owner', v_name),
    jsonb_build_object('via', 'early_access_signup'));
  return jsonb_build_object('company_id', v_id, 'created', true, 'name', v_name);
end;
$$;

-- An existing, verified account creates another company with an access code.
-- Idempotent per request key; attempts are rate limited per user (5 failures
-- in 15 minutes) and bad codes do not raise, so the attempt is recorded.
create or replace function public.create_company_with_access_code(p_code_hash text, p_company_name text, p_request_key uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := auth.uid();
  v_key   text := md5(coalesce(auth.uid()::text, ''));
  v_r     private.early_access_redemptions%rowtype;
  v_state record;
  v_name  text := trim(coalesce(p_company_name, ''));
  v_id    uuid;
begin
  if v_uid is null then raise exception 'Sign in first.' using errcode = '42501'; end if;
  if not exists (select 1 from auth.users where id = v_uid and email_confirmed_at is not null) then
    raise exception 'Confirm your email address first.' using errcode = '42501';
  end if;
  select * into v_r from private.early_access_redemptions where request_key = p_request_key;
  if found then
    if v_r.user_id <> v_uid then raise exception 'This request was already used.' using errcode = '42501'; end if;
    return jsonb_build_object('ok', true, 'company_id', v_r.company_id, 'created', false);
  end if;
  if private.access_rate_limited('user', v_key, 5) then
    return jsonb_build_object('ok', false, 'reason', 'rate_limited');
  end if;
  if length(v_name) not between 2 and 120 then return jsonb_build_object('ok', false, 'reason', 'company_name'); end if;
  select * into v_state from private.early_access_code_state(coalesce(p_code_hash, ''), true);
  insert into private.access_attempts (scope, key_hash, success) values ('user', v_key, v_state.valid);
  if not v_state.valid then return jsonb_build_object('ok', false, 'reason', v_state.reason); end if;

  v_id := private.provision_company(v_uid, v_name);
  insert into private.early_access_redemptions (code_id, user_id, company_name, request_key, status, company_id, completed_at)
  values (v_state.code_id, v_uid, v_name, p_request_key, 'completed', v_id, now());
  perform private.log_event('company.created', 'company', v_id, format('Company %s created by its owner', v_name),
    jsonb_build_object('via', 'early_access_existing_account'));
  return jsonb_build_object('ok', true, 'company_id', v_id, 'created', true);
end;
$$;

-- -----------------------------------------------------------------------------
-- 4. Several companies per person
-- -----------------------------------------------------------------------------
create or replace function public.my_companies()
returns table (company_id uuid, name text, role public.app_role, current boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select c.id, c.name, m.role, c.id = private.current_company_id()
  from public.company_memberships m
  join public.companies c on c.id = m.company_id and c.active
  where m.user_id = auth.uid() and m.active and m.role is not null
  order by c.name
$$;

-- Work in another of the caller's companies. Data access follows
-- private.current_company_id(), which reads this choice.
create or replace function public.switch_company(p_company_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.company_memberships m join public.companies c on c.id = m.company_id and c.active
                 where m.user_id = auth.uid() and m.company_id = p_company_id and m.active and m.role is not null) then
    raise exception 'You are not an active member of that company.' using errcode = '42501';
  end if;
  update public.profiles set active_company_id = p_company_id where id = auth.uid();
end;
$$;

-- -----------------------------------------------------------------------------
-- 5. Invitations and roles
-- -----------------------------------------------------------------------------
-- Add an existing account (found by email) to the caller's company.
-- Returns found=false when no account exists (the server then sends a Supabase
-- invitation). Repeating returns already=true.
create or replace function public.add_existing_member(p_email text, p_role public.app_role, p_full_name text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid;
  v_user    uuid;
  v_m       public.company_memberships%rowtype;
begin
  perform private.require_permission('users.manage');
  v_company := private.require_company();
  if p_role = 'owner' and private.current_app_role() is distinct from 'owner' then
    raise exception 'Only an owner can add another owner.' using errcode = '42501';
  end if;
  select id into v_user from public.profiles where lower(email) = lower(trim(p_email));
  if v_user is null then return jsonb_build_object('found', false); end if;

  select * into v_m from public.company_memberships where company_id = v_company and user_id = v_user;
  if found then
    if not v_m.active then
      raise exception 'This person was deactivated in your company. Reactivate them in the list below.';
    end if;
    return jsonb_build_object('found', true, 'already', true, 'user_id', v_user, 'role', v_m.role);
  end if;
  insert into public.company_memberships (company_id, user_id, role, active) values (v_company, v_user, p_role, true);
  -- A profile is shared: name it only if it has no other company.
  update public.profiles set full_name = trim(p_full_name)
  where id = v_user and length(trim(coalesce(p_full_name, ''))) between 1 and 120
    and not exists (select 1 from public.company_memberships m where m.user_id = v_user and m.company_id <> v_company);
  perform private.log_event('member.added', 'user', v_user, format('Existing account added as %s', p_role),
    jsonb_build_object('role', p_role));
  return jsonb_build_object('found', true, 'already', false, 'user_id', v_user, 'role', p_role);
end;
$$;

-- Same as 20261011000200, plus: only an owner can add an owner; adding someone
-- who is already a member is reported, not duplicated.
create or replace function public.add_company_member(p_user_id uuid, p_role public.app_role, p_full_name text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid;
begin
  perform private.require_permission('users.manage');
  v_company := private.require_company();
  if p_role = 'owner' and private.current_app_role() is distinct from 'owner' then
    raise exception 'Only an owner can add another owner.' using errcode = '42501';
  end if;

  if not exists (select 1 from public.profiles where id = p_user_id) then
    raise exception 'User not found.';
  end if;

  insert into public.company_memberships (company_id, user_id, role, active)
  values (v_company, p_user_id, p_role, true);

  update public.profiles
     set full_name = trim(p_full_name)
   where id = p_user_id
     and length(trim(coalesce(p_full_name, ''))) between 1 and 120
     and not exists (select 1 from public.company_memberships m
                     where m.user_id = p_user_id and m.company_id <> v_company);
exception
  when unique_violation then
    raise exception 'This user is already a member of your company.';
end;
$$;

-- Same as 20261011000200, plus: only an owner can make someone an owner or
-- change an owner's role.
create or replace function public.set_user_access(p_user_id uuid, p_role public.app_role, p_active boolean, p_full_name text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid;
  v_remaining_owners integer;
  v_current public.app_role;
begin
  perform private.require_permission('users.manage');
  v_company := private.require_company();

  if p_full_name is null or length(trim(p_full_name)) = 0 or length(p_full_name) > 120 then
    raise exception 'Name is required (120 characters max).';
  end if;

  select role into v_current from public.company_memberships where company_id = v_company and user_id = p_user_id;
  if (p_role = 'owner' or v_current = 'owner') and p_role is distinct from v_current
     and private.current_app_role() is distinct from 'owner' then
    raise exception 'Only an owner can grant or remove the Owner role.' using errcode = '42501';
  end if;

  update public.company_memberships
     set role = p_role,
         active = p_active
   where company_id = v_company and user_id = p_user_id;
  if not found then
    raise exception 'User not found.';
  end if;

  update public.profiles
     set full_name = trim(p_full_name)
   where id = p_user_id
     and not exists (select 1 from public.company_memberships m
                     where m.user_id = p_user_id and m.company_id <> v_company);

  select count(*) into v_remaining_owners
  from public.company_memberships
  where company_id = v_company and role = 'owner' and active;

  if v_remaining_owners = 0 then
    raise exception 'At least one active owner account is required.';
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- 6. Grants
-- -----------------------------------------------------------------------------
revoke execute on function
  public.early_access_check(text, text, text),
  public.early_access_reserve(text, uuid, text, uuid),
  public.early_access_request(uuid),
  public.early_access_create_code(text, text, integer, timestamptz),
  public.early_access_list_codes(),
  public.early_access_revoke_code(uuid, text)
from public, anon, authenticated;
grant execute on function
  public.early_access_check(text, text, text),
  public.early_access_reserve(text, uuid, text, uuid),
  public.early_access_request(uuid),
  public.early_access_create_code(text, text, integer, timestamptz),
  public.early_access_list_codes(),
  public.early_access_revoke_code(uuid, text)
to service_role;

revoke execute on function
  public.my_onboarding(),
  public.complete_company_onboarding(text),
  public.create_company_with_access_code(text, text, uuid),
  public.my_companies(),
  public.switch_company(uuid),
  public.add_existing_member(text, public.app_role, text)
from public, anon;
grant execute on function
  public.my_onboarding(),
  public.complete_company_onboarding(text),
  public.create_company_with_access_code(text, text, uuid),
  public.my_companies(),
  public.switch_company(uuid),
  public.add_existing_member(text, public.app_role, text)
to authenticated;

revoke execute on function
  private.early_access_code_state(text, boolean),
  private.access_rate_limited(text, text, integer),
  private.provision_company(uuid, text)
from public, anon, authenticated;
