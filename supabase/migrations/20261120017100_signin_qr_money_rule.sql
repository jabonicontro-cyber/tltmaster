-- =============================================================================
-- QR and face or fingerprint sign-in stay for driver sign-ins without money access (master plan §12 DS1 and SEC4,
-- owner 2026-11-09). Two-step verification will be required for anyone who can see or change money; a sign-in that
-- skips typing (a one-time QR code, a passkey) is therefore only for driver accounts that hold no money permission.
--
-- Money permissions (same list as MONEY_PERMISSIONS in src/lib/permissions.ts): every billing.* and pricing.*
-- permission, payroll.manage, employees.compensation, accounting.view, maintenance.costs and audit.view.
--
--   * private.signin_qr_refusal (20261120017000) also refuses ('money') a sign-in whose role holds a money permission
--     in any company it belongs to, so a code is refused both when it is shown and when it is used (an owner may give
--     the driver role a money permission in the meantime).
--   * public.signin_qr_issue says so in plain words.
--   * public.my_passkey_refusal: why the signed-in person may not set up or use face or fingerprint sign-in, or null.
--     Refused for the Taviron team (their two-step rule stays the authenticator app), customer portal accounts,
--     anyone who is not only an active driver, anyone holding a money permission, and demo companies (a demo sign-in is
--     fictional and shared; nothing real is added to it). The server asks it before setting a passkey up and again
--     after a passkey sign-in (the session is ended when it is refused).
--
-- Additive: replaces two functions of 20261120017000 and adds three; no table or row changes.
-- Rollback: supabase/rollbacks/20261120017100_signin_qr_money_rule.down.sql
-- =============================================================================

/** Is this permission code about money (SEC4)? */
create or replace function private.is_money_permission(p_permission text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(p_permission like 'billing.%' or p_permission like 'pricing.%'
    or p_permission in ('payroll.manage', 'employees.compensation', 'accounting.view', 'maintenance.costs', 'audit.view'), false);
$$;
revoke all on function private.is_money_permission(text) from public, anon, authenticated;

/** Does this person hold a money permission through any active membership, in any company? */
create or replace function private.holds_money_permission(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.company_memberships m
    join public.role_permissions rp on rp.company_id = m.company_id and rp.role = m.role
    where m.user_id = p_user and m.active and private.is_money_permission(rp.permission)
  );
$$;
revoke all on function private.holds_money_permission(uuid) from public, anon, authenticated;

create or replace function private.signin_qr_refusal(p_company uuid, p_user uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when not exists (select 1 from public.companies c where c.id = p_company and c.active and not c.is_demo) then 'company'
    when not exists (select 1 from auth.users u where u.id = p_user and u.deleted_at is null) then 'missing'
    when exists (select 1 from auth.users u where u.id = p_user and coalesce(lower(u.email), '') not like '%@users.mytaviron.com') then 'not_username'
    when exists (select 1 from auth.users u where u.id = p_user and u.banned_until is not null and u.banned_until > now()) then 'blocked'
    when not exists (select 1 from public.company_memberships m
                     where m.company_id = p_company and m.user_id = p_user and m.active and m.role = 'driver'
                       and (m.access_ends_at is null or m.access_ends_at > now())) then 'not_driver'
    when exists (select 1 from public.company_memberships m where m.user_id = p_user and m.company_id <> p_company)
      or exists (select 1 from public.portal_accounts a where a.user_id = p_user)
      or exists (select 1 from private.platform_admins pa where pa.user_id = p_user and pa.revoked_at is null) then 'elsewhere'
    when private.holds_money_permission(p_user) then 'money'
    when exists (select 1 from private.account_setups s where s.user_id = p_user and s.status = 'setup_required' and s.expires_at <= now()) then 'setup_expired'
    else null
  end;
$$;
revoke all on function private.signin_qr_refusal(uuid, uuid) from public, anon, authenticated;

/** Show a QR code for a driver (users.manage). The server passes only the SHA-256 of the token it generated. */
create or replace function public.signin_qr_issue(p_driver uuid, p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v_user uuid;
  v_name text;
  v_reason text;
  v_id uuid;
  v_expires timestamptz := now() + interval '10 minutes';
begin
  perform private.require_permission('users.manage');
  if private.support_company() is not null then
    raise exception 'Taviron support cannot change who can sign in to the company. Ask an owner of the company.' using errcode = '42501';
  end if;
  if exists (select 1 from public.companies c where c.id = v_company and c.is_demo) then
    raise exception 'Demo companies never sign a phone in: the code shown in a demo is a sample.' using errcode = '42501';
  end if;
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid code.' using errcode = '22023';
  end if;
  select d.user_id, coalesce(nullif(trim(d.name), ''), 'Driver') into v_user, v_name
  from public.drivers d where d.id = p_driver and d.company_id = v_company and d.active;
  if not found then raise exception 'Driver not found.' using errcode = 'P0002'; end if;
  if v_user is null then
    raise exception 'This driver has no sign-in yet. Set up their phone sign-in first.' using errcode = '22023';
  end if;
  v_reason := private.signin_qr_refusal(v_company, v_user);
  if v_reason is not null then
    raise exception '%', case v_reason
      when 'not_driver' then 'QR sign-in is only for active driver sign-ins.'
      when 'blocked' then 'This sign-in is turned off. Turn it on first.'
      when 'setup_expired' then 'This driver''s first sign-in sheet has expired. Reissue it first, then show the code.'
      when 'elsewhere' then 'This sign-in is also used elsewhere, so it cannot be signed in from here.'
      when 'not_username' then 'QR sign-in works for username sign-ins only.'
      when 'money' then 'This sign-in can see or change money (billing, prices, pay, costs or the accounting or audit records), so it signs in with a password and two-step verification, not a QR code. Check Settings → Roles and permissions for the driver role.'
      else 'This sign-in cannot be signed in with a code.'
    end using errcode = '42501';
  end if;
  -- Same rules as resetting a sign-in too: this company's username sign-in only, nobody's own, owners only by owners.
  perform private.account_issue_allowed(v_user, 'employee');
  if (select count(*) from private.signin_qr_codes q where q.user_id = v_user and q.issued_at > now() - interval '10 minutes') >= 5 then
    raise exception 'Too many codes for this driver. Wait a few minutes and try again.' using errcode = 'P0001';
  end if;
  if (select count(*) from private.signin_qr_codes q where q.issued_by = auth.uid() and q.issued_at > now() - interval '1 hour') >= 30 then
    raise exception 'Too many codes shown in the last hour. Wait a while and try again.' using errcode = 'P0001';
  end if;
  -- One open code per driver: an earlier one stops working.
  update private.signin_qr_codes set closed_at = now(), outcome = 'replaced' where user_id = v_user and closed_at is null;
  insert into private.signin_qr_codes (company_id, user_id, driver_id, token_hash, issued_by, expires_at)
  values (v_company, v_user, p_driver, p_token_hash, auth.uid(), v_expires)
  returning id into v_id;
  perform private.account_audit(v_company, 'account.qr_issued', v_user, 'Sign-in QR code shown',
    jsonb_build_object('kind', 'employee', 'method', 'qr', 'expires_at', v_expires));
  return jsonb_build_object('id', v_id, 'expires_at', v_expires, 'driver_name', v_name);
end;
$$;
revoke all on function public.signin_qr_issue(uuid, text) from public, anon;
grant execute on function public.signin_qr_issue(uuid, text) to authenticated;

/**
 * Why the signed-in person may not set up or use face or fingerprint sign-in (a code), or null when they may.
 * Reads only the caller's own sign-in; works at any assurance level (it does not need a current company).
 */
create or replace function public.my_passkey_refusal()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when auth.uid() is null then 'signed_out'
    when exists (select 1 from private.platform_admins a where a.user_id = auth.uid() and a.revoked_at is null) then 'staff'
    when exists (select 1 from public.portal_accounts a where a.user_id = auth.uid()) then 'not_driver'
    when not exists (select 1 from public.company_memberships m join public.companies c on c.id = m.company_id and c.active
                     where m.user_id = auth.uid() and m.active and m.role = 'driver'
                       and (m.access_ends_at is null or m.access_ends_at > now())) then 'not_driver'
    when exists (select 1 from public.company_memberships m where m.user_id = auth.uid() and m.active and m.role is distinct from 'driver') then 'not_driver'
    when private.holds_money_permission(auth.uid()) then 'money'
    when exists (select 1 from public.company_memberships m join public.companies c on c.id = m.company_id
                 where m.user_id = auth.uid() and m.active and c.is_demo) then 'demo'
    else null
  end;
$$;
revoke all on function public.my_passkey_refusal() from public, anon;
grant execute on function public.my_passkey_refusal() to authenticated;
