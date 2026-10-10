-- =============================================================================
-- Early-access site gate (N12)
--
-- The existing early-access codes (N9, `private.early_access_codes`) gain a
-- purpose:
--   * 'company_signup' — the existing codes: create one company (consumed);
--   * 'site_access'    — admit a device to the restricted application (sign-in
--                        and approved registration). Never creates an account,
--                        a company, a membership or any permission.
-- A code of one purpose is never accepted for the other.
--
-- Redeeming a site code (server, service role) creates a *grant* — one per
-- device/browser — that the app keeps in a signed, HttpOnly cookie. The app
-- re-checks the grant here periodically, so revoking a code, a grant or all
-- grants of a code ends access within minutes. Failed attempts are rate limited
-- per client address. Administrative changes are recorded in
-- `private.early_access_audit`.
--
-- Everything stays in the private schema and is reachable only through
-- service-role functions. Additive: existing codes keep their behavior.
-- =============================================================================

alter table private.early_access_codes
  add column purpose text not null default 'company_signup' check (purpose in ('company_signup', 'site_access'));

alter table private.access_attempts drop constraint access_attempts_scope_check;
alter table private.access_attempts add constraint access_attempts_scope_check check (scope in ('ip', 'email', 'user', 'site'));

create table private.site_access_grants (
  id            uuid primary key default gen_random_uuid(),
  code_id       uuid not null references private.early_access_codes (id) on delete cascade,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  last_seen_at  timestamptz not null default now(),
  -- Keyed hash of the client address (never the address itself).
  ip_key        text not null default '',
  revoked_at    timestamptz,
  revoke_reason text not null default '',
  check (expires_at > created_at)
);
create index site_access_grants_code_idx on private.site_access_grants (code_id);

create table private.early_access_audit (
  id          uuid primary key default gen_random_uuid(),
  action      text not null check (action in ('code_created', 'code_revoked', 'grants_revoked', 'grant_revoked')),
  code_id     uuid references private.early_access_codes (id) on delete set null,
  grant_id    uuid,
  detail      jsonb not null default '{}',
  actor       text not null default current_user,
  occurred_at timestamptz not null default now()
);

revoke all on private.site_access_grants, private.early_access_audit from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Code state, by purpose (callers from N9 keep 'company_signup')
-- -----------------------------------------------------------------------------
drop function private.early_access_code_state(text, boolean);
create function private.early_access_code_state(p_code_hash text, p_lock boolean default false, p_purpose text default 'company_signup')
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
    select * into v_c from private.early_access_codes where code_hash = p_code_hash and purpose = p_purpose for update;
  else
    select * into v_c from private.early_access_codes where code_hash = p_code_hash and purpose = p_purpose;
  end if;
  -- A code of another purpose is simply unknown here.
  if not found then return query select null::uuid, false, 'unknown'; return; end if;
  if v_c.revoked_at is not null then return query select v_c.id, false, 'revoked'; return; end if;
  if v_c.expires_at <= now() then return query select v_c.id, false, 'expired'; return; end if;
  if p_purpose = 'site_access' then
    select count(*) into v_used from private.site_access_grants g where g.code_id = v_c.id;
  else
    select count(*) into v_used from private.early_access_redemptions r where r.code_id = v_c.id;
  end if;
  if v_used >= v_c.max_uses then return query select v_c.id, false, 'used_up'; return; end if;
  return query select v_c.id, true, 'ok';
end;
$$;

-- -----------------------------------------------------------------------------
-- Operator functions (service role): create with a purpose, list, revoke, audit
-- -----------------------------------------------------------------------------
drop function public.early_access_create_code(text, text, integer, timestamptz);
create function public.early_access_create_code(p_code_hash text, p_label text, p_max_uses integer, p_expires_at timestamptz,
                                                p_purpose text default 'company_signup')
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_expires_at <= now() then raise exception 'The expiry must be in the future.'; end if;
  if p_purpose not in ('company_signup', 'site_access') then raise exception 'Unknown code purpose.'; end if;
  insert into private.early_access_codes (code_hash, label, max_uses, expires_at, purpose)
  values (p_code_hash, trim(p_label), p_max_uses, p_expires_at, p_purpose)
  returning id into v_id;
  insert into private.early_access_audit (action, code_id, detail)
  values ('code_created', v_id, jsonb_build_object('purpose', p_purpose, 'label', trim(p_label), 'max_uses', p_max_uses, 'expires_at', p_expires_at));
  return v_id;
end;
$$;

drop function public.early_access_list_codes();
create function public.early_access_list_codes()
returns table (id uuid, purpose text, label text, max_uses integer, used integer, active_grants integer,
               expires_at timestamptz, revoked_at timestamptz, revoke_reason text, created_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select c.id, c.purpose, c.label, c.max_uses,
         case when c.purpose = 'site_access'
              then (select count(*)::int from private.site_access_grants g where g.code_id = c.id)
              else (select count(*)::int from private.early_access_redemptions r where r.code_id = c.id) end,
         (select count(*)::int from private.site_access_grants g
           where g.code_id = c.id and g.revoked_at is null and g.expires_at > now()),
         c.expires_at, c.revoked_at, c.revoke_reason, c.created_at
  from private.early_access_codes c
  order by c.created_at desc
$$;

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
  -- Devices admitted with the code lose access at their next check.
  update private.site_access_grants set revoked_at = now(), revoke_reason = 'Code revoked: ' || trim(p_reason)
  where code_id = p_code_id and revoked_at is null;
  insert into private.early_access_audit (action, code_id, detail) values ('code_revoked', p_code_id, jsonb_build_object('reason', trim(p_reason)));
end;
$$;

/** End every device's access granted with a code, keeping the code usable (e.g. after sharing it too widely, combined with a new code). */
create or replace function public.site_access_revoke_grants(p_code_id uuid, p_reason text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n integer;
begin
  if length(trim(coalesce(p_reason, ''))) = 0 then raise exception 'Enter a reason.'; end if;
  update private.site_access_grants set revoked_at = now(), revoke_reason = trim(p_reason)
  where code_id = p_code_id and revoked_at is null;
  get diagnostics v_n = row_count;
  insert into private.early_access_audit (action, code_id, detail) values ('grants_revoked', p_code_id, jsonb_build_object('reason', trim(p_reason), 'count', v_n));
  return v_n;
end;
$$;

-- -----------------------------------------------------------------------------
-- The gate (service role, called by the app server)
-- -----------------------------------------------------------------------------
/**
 * Redeem a site-access code for one device. Rate limited per client address
 * (10 failed attempts per 15 minutes); every attempt is recorded as a keyed
 * hash only. Returns ok + grant id + expiry, or a reason. Never raises for a
 * wrong code.
 */
create or replace function public.site_access_redeem(p_code_hash text, p_ip_hash text, p_days integer default 30)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ip    text := coalesce(nullif(p_ip_hash, ''), 'unknown');
  v_state record;
  v_code  private.early_access_codes%rowtype;
  v_grant private.site_access_grants%rowtype;
  v_days  integer := least(greatest(coalesce(p_days, 30), 1), 90);
begin
  if private.access_rate_limited('site', v_ip, 10) then
    return jsonb_build_object('ok', false, 'reason', 'rate_limited');
  end if;
  select * into v_state from private.early_access_code_state(coalesce(p_code_hash, ''), true, 'site_access');
  insert into private.access_attempts (scope, key_hash, success) values ('site', v_ip, v_state.valid);
  if not v_state.valid then
    return jsonb_build_object('ok', false, 'reason', v_state.reason);
  end if;
  select * into v_code from private.early_access_codes where id = v_state.code_id;
  insert into private.site_access_grants (code_id, expires_at, ip_key)
  values (v_code.id, least(now() + make_interval(days => v_days), v_code.expires_at), v_ip)
  returning * into v_grant;
  return jsonb_build_object('ok', true, 'grant_id', v_grant.id, 'expires_at', v_grant.expires_at);
end;
$$;

/** Is this grant still valid (not revoked or expired, and its code neither)? Records that it was seen. */
create or replace function public.site_access_validate(p_grant_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_g private.site_access_grants%rowtype;
  v_c private.early_access_codes%rowtype;
begin
  select * into v_g from private.site_access_grants where id = p_grant_id;
  if not found then return jsonb_build_object('valid', false, 'reason', 'unknown'); end if;
  select * into v_c from private.early_access_codes where id = v_g.code_id;
  if v_g.revoked_at is not null or v_c.revoked_at is not null then return jsonb_build_object('valid', false, 'reason', 'revoked'); end if;
  if v_g.expires_at <= now() or v_c.expires_at <= now() then return jsonb_build_object('valid', false, 'reason', 'expired'); end if;
  update private.site_access_grants set last_seen_at = now() where id = v_g.id and last_seen_at < now() - interval '1 minute';
  return jsonb_build_object('valid', true, 'expires_at', least(v_g.expires_at, v_c.expires_at));
end;
$$;

revoke execute on function
  private.early_access_code_state(text, boolean, text),
  public.early_access_create_code(text, text, integer, timestamptz, text),
  public.early_access_list_codes(),
  public.early_access_revoke_code(uuid, text),
  public.site_access_revoke_grants(uuid, text),
  public.site_access_redeem(text, text, integer),
  public.site_access_validate(uuid)
from public, anon, authenticated;
grant execute on function
  public.early_access_create_code(text, text, integer, timestamptz, text),
  public.early_access_list_codes(),
  public.early_access_revoke_code(uuid, text),
  public.site_access_revoke_grants(uuid, text),
  public.site_access_redeem(text, text, integer),
  public.site_access_validate(uuid)
to service_role;
