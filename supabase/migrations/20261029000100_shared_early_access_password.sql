-- =============================================================================
-- Shared Early Access password
--
-- Alongside the per-recipient site codes (N12), the Early Access page accepts
-- one shared password that the owner hands to selected prospects. The password
-- lives only in the server environment (EARLY_ACCESS_PASSWORD); the app checks
-- it and sends the database a *fingerprint*: HMAC-SHA256 keyed with the
-- server's SITE_ACCESS_SECRET. The database never sees the password.
--
-- Each device that enters the shared password still gets its own grant in
-- private.site_access_grants, exactly like a code: the same signed cookie, the
-- same periodic re-check (site_access_validate), the same revocation. So:
--   * revoking one device, or every device admitted with the password, works
--     as before (scripts/early-access.mjs);
--   * changing the password retires the old one: the first entry with the new
--     password revokes the previous password's record and its devices;
--   * revoking the password's record is a kill switch — the same password is
--     refused until it is changed.
-- Passing the gate still grants no account, company, membership or permission.
--
-- Additive: site codes keep working unchanged.
-- Rollback: supabase/rollbacks/20261029000100_shared_early_access_password.down.sql
-- =============================================================================

-- The password's record is an early_access_codes row of its own purpose, so
-- the code path (purpose 'site_access') never matches it.
alter table private.early_access_codes drop constraint early_access_codes_purpose_check;
alter table private.early_access_codes add constraint early_access_codes_purpose_check
  check (purpose in ('company_signup', 'site_access', 'site_shared'));

alter table private.early_access_audit drop constraint early_access_audit_action_check;
alter table private.early_access_audit add constraint early_access_audit_action_check
  check (action in ('code_created', 'code_revoked', 'grants_revoked', 'grant_revoked', 'shared_rotated'));

-- -----------------------------------------------------------------------------
-- Enter with the shared password (service role, called by the app server only
-- after it has verified the password itself)
-- -----------------------------------------------------------------------------
/**
 * Admit one device with the shared password. The rate limit is checked first,
 * so a correct password after too many failures from the same address is still
 * refused. p_max_devices caps the devices admitted at the same time (1–1000).
 * Returns ok + grant id + expiry, or a reason (rate_limited, revoked, used_up).
 */
create or replace function public.site_access_enter_shared(p_fingerprint text, p_ip_hash text, p_days integer default 30, p_max_devices integer default 500)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ip     text := coalesce(nullif(p_ip_hash, ''), 'unknown');
  v_days   integer := least(greatest(coalesce(p_days, 30), 1), 90);
  v_max    integer := least(greatest(coalesce(p_max_devices, 500), 1), 1000);
  v_code   private.early_access_codes%rowtype;
  v_active integer;
  v_old    record;
  v_grant  private.site_access_grants%rowtype;
begin
  if coalesce(p_fingerprint, '') !~ '^[0-9a-f]{64}$' then raise exception 'Invalid fingerprint.'; end if;
  if private.access_rate_limited('site', v_ip, 10) then
    return jsonb_build_object('ok', false, 'reason', 'rate_limited');
  end if;

  select * into v_code from private.early_access_codes where code_hash = p_fingerprint and purpose = 'site_shared' for update;
  if not found then
    -- A new password: retire the previous one and the devices admitted with it.
    for v_old in select id from private.early_access_codes where purpose = 'site_shared' and revoked_at is null for update loop
      update private.early_access_codes set revoked_at = now(), revoke_reason = 'Shared password changed' where id = v_old.id;
      update private.site_access_grants set revoked_at = now(), revoke_reason = 'Shared password changed'
      where code_id = v_old.id and revoked_at is null;
      insert into private.early_access_audit (action, code_id, detail) values ('shared_rotated', v_old.id, '{}');
    end loop;
    insert into private.early_access_codes (code_hash, label, max_uses, expires_at, purpose)
    values (p_fingerprint, 'Shared early-access password', v_max, now() + interval '5 years', 'site_shared')
    on conflict (code_hash) do nothing;
    select * into v_code from private.early_access_codes where code_hash = p_fingerprint and purpose = 'site_shared' for update;
    if not found then raise exception 'Fingerprint already in use.'; end if;
    insert into private.early_access_audit (action, code_id, detail)
    values ('code_created', v_code.id, jsonb_build_object('purpose', 'site_shared', 'max_uses', v_max));
  end if;

  if v_code.revoked_at is not null or v_code.expires_at <= now() then
    insert into private.access_attempts (scope, key_hash, success) values ('site', v_ip, false);
    return jsonb_build_object('ok', false, 'reason', 'revoked');
  end if;
  -- The device cap follows the current setting; it counts devices admitted now.
  if v_code.max_uses <> v_max then
    update private.early_access_codes set max_uses = v_max where id = v_code.id;
  end if;
  select count(*) into v_active from private.site_access_grants g
  where g.code_id = v_code.id and g.revoked_at is null and g.expires_at > now();
  if v_active >= v_max then
    return jsonb_build_object('ok', false, 'reason', 'used_up');
  end if;

  insert into private.access_attempts (scope, key_hash, success) values ('site', v_ip, true);
  insert into private.site_access_grants (code_id, expires_at, ip_key)
  values (v_code.id, least(now() + make_interval(days => v_days), v_code.expires_at), v_ip)
  returning * into v_grant;
  return jsonb_build_object('ok', true, 'grant_id', v_grant.id, 'expires_at', v_grant.expires_at);
end;
$$;

/** End one device's early access (the device itself leaving, or the operator). */
create or replace function public.site_access_revoke_grant(p_grant_id uuid, p_reason text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_code uuid;
begin
  if length(trim(coalesce(p_reason, ''))) = 0 then raise exception 'Enter a reason.'; end if;
  update private.site_access_grants set revoked_at = now(), revoke_reason = trim(p_reason)
  where id = p_grant_id and revoked_at is null
  returning code_id into v_code;
  if not found then return false; end if;
  insert into private.early_access_audit (action, code_id, grant_id, detail)
  values ('grant_revoked', v_code, p_grant_id, jsonb_build_object('reason', trim(p_reason)));
  return true;
end;
$$;

-- Listing shows the password's record with its devices, like a site code.
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
         case when c.purpose in ('site_access', 'site_shared')
              then (select count(*)::int from private.site_access_grants g where g.code_id = c.id)
              else (select count(*)::int from private.early_access_redemptions r where r.code_id = c.id) end,
         (select count(*)::int from private.site_access_grants g
           where g.code_id = c.id and g.revoked_at is null and g.expires_at > now()),
         c.expires_at, c.revoked_at, c.revoke_reason, c.created_at
  from private.early_access_codes c
  order by c.created_at desc
$$;

revoke execute on function
  public.site_access_enter_shared(text, text, integer, integer),
  public.site_access_revoke_grant(uuid, text),
  public.early_access_list_codes()
from public, anon, authenticated;
grant execute on function
  public.site_access_enter_shared(text, text, integer, integer),
  public.site_access_revoke_grant(uuid, text),
  public.early_access_list_codes()
to service_role;
