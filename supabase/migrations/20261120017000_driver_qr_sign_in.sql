-- =============================================================================
-- Driver sign-in without typing (master plan §12 DS1, owner 2026-11-09): one-time QR codes, and the audit trail for
-- face or fingerprint sign-in (passkeys, Supabase Auth).
--
-- QR codes. Someone who manages sign-ins (users.manage) opens a driver in Fleet and shows a QR code. The application
-- server makes a random 256-bit token, keeps it only in the code it shows, and gives the database its SHA-256 (this
-- table never holds the token). The phone that scans it opens /auth/qr; the server redeems the token here with the
-- service role and signs that phone in as the driver (a real Supabase Auth session made on the server).
--
--   * Single use, 10 minutes, bound to one company, one driver record and its sign-in; a new code replaces the
--     driver's earlier open code; the office can cancel it (closing the window does).
--   * Only for a driver sign-in that this company may manage (private.account_issue_allowed: a username sign-in in this
--     company only, no other company, no customer portal, not a platform administrator, never the person themselves),
--     with an active membership whose role is driver. Owners, office staff, dispatchers and mechanics are refused.
--     A turned-off or blocked sign-in, and a first-sign-in sheet that has expired, are refused.
--   * Everything is checked again when the code is used (the person may have been turned off meanwhile).
--   * Never in a demo company (nothing real is signed in from a demo; the app shows a labelled sample instead), and
--     never during a Taviron support visit (a visit never changes who can sign in, 20261120008900): refused here and by
--     the z_no_support_visit trigger on the table.
--   * Rate limits: 5 codes per driver in 10 minutes, 30 per person issuing them per hour. Invented codes are
--     counted per network address by the server (public.signin_failed).
--   * Audited in audit_events and security_events (issued, used, expired, refused, cancelled, failed), never with the
--     token or its hash.
--
-- Passkeys are stored by Supabase Auth itself; the company's side is only the audit (registered by the person, removed
-- by the office for a lost phone) and the permission check before the server removes them with the Auth admin API.
--
-- Rollback: supabase/rollbacks/20261120017000_driver_qr_sign_in.down.sql
-- =============================================================================

create table private.signin_qr_codes (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies (id) on delete cascade,
  user_id     uuid not null references auth.users (id) on delete cascade,
  driver_id   uuid not null,
  token_hash  text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  issued_by   uuid references auth.users (id) on delete set null,
  issued_at   timestamptz not null default now(),
  expires_at  timestamptz not null,
  closed_at   timestamptz,
  outcome     text not null default '' check (outcome in ('', 'used', 'expired', 'refused', 'cancelled', 'replaced', 'failed')),
  check ((outcome = '') = (closed_at is null)),
  foreign key (company_id, driver_id) references public.drivers (company_id, id) on delete cascade
);
create index signin_qr_codes_user on private.signin_qr_codes (user_id, issued_at desc);
create index signin_qr_codes_issuer on private.signin_qr_codes (issued_by, issued_at desc);
alter table private.signin_qr_codes enable row level security;
revoke all on private.signin_qr_codes from public, anon, authenticated;

create trigger z_no_support_visit before insert or update or delete on private.signin_qr_codes
  for each row execute function private.forbid_during_support_visit();

/**
 * Why this sign-in may not be signed in with a QR code now, or null when it may. Checked when a code is shown and
 * again when it is used. Reasons are codes, never shown with any personal detail.
 */
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

/** Is the code still waiting, or was it used, cancelled, expired …? For the office's window (users.manage). */
create or replace function public.signin_qr_status(p_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  r private.signin_qr_codes;
begin
  perform private.require_permission('users.manage');
  select * into r from private.signin_qr_codes q where q.id = p_id and q.company_id = v_company;
  if not found then raise exception 'Code not found.' using errcode = 'P0002'; end if;
  if r.closed_at is null then return case when r.expires_at <= now() then 'expired' else 'waiting' end; end if;
  return r.outcome;
end;
$$;
revoke all on function public.signin_qr_status(uuid) from public, anon;
grant execute on function public.signin_qr_status(uuid) to authenticated;

/** Stop an open code (the office closed the window). */
create or replace function public.signin_qr_cancel(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v_user uuid;
begin
  perform private.require_permission('users.manage');
  update private.signin_qr_codes q set closed_at = now(), outcome = 'cancelled'
  where q.id = p_id and q.company_id = v_company and q.closed_at is null
  returning q.user_id into v_user;
  if v_user is not null then
    perform private.account_audit(v_company, 'account.qr_cancelled', v_user, 'Sign-in QR code cancelled', jsonb_build_object('kind', 'employee', 'method', 'qr'));
  end if;
end;
$$;
revoke all on function public.signin_qr_cancel(uuid) from public, anon;
grant execute on function public.signin_qr_cancel(uuid) to authenticated;

/**
 * Use a code (service role only: the server then makes the session). Locks the row so a code works once even when
 * two phones scan it at the same moment. Returns ok with the sign-in to open, or a refusal code.
 */
create or replace function public.signin_qr_redeem(p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r private.signin_qr_codes;
  v_reason text;
  v_email text;
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then return jsonb_build_object('ok', false, 'reason', 'invalid'); end if;
  select * into r from private.signin_qr_codes q where q.token_hash = p_token_hash for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'invalid'); end if;
  if r.closed_at is not null then
    perform private.account_audit(r.company_id, 'account.qr_refused', r.user_id, 'Sign-in QR code refused (already used or replaced)',
      jsonb_build_object('kind', 'employee', 'method', 'qr', 'reason', coalesce(nullif(r.outcome, ''), 'closed')));
    return jsonb_build_object('ok', false, 'reason', case when r.outcome in ('cancelled', 'replaced') then 'replaced' when r.outcome = 'expired' then 'expired' else 'used' end);
  end if;
  if r.expires_at <= now() then
    update private.signin_qr_codes set closed_at = now(), outcome = 'expired' where id = r.id;
    perform private.account_audit(r.company_id, 'account.qr_expired', r.user_id, 'Sign-in QR code refused (expired)', jsonb_build_object('kind', 'employee', 'method', 'qr'));
    return jsonb_build_object('ok', false, 'reason', 'expired');
  end if;
  v_reason := private.signin_qr_refusal(r.company_id, r.user_id);
  if v_reason is not null then
    update private.signin_qr_codes set closed_at = now(), outcome = 'refused' where id = r.id;
    perform private.account_audit(r.company_id, 'account.qr_refused', r.user_id, 'Sign-in QR code refused',
      jsonb_build_object('kind', 'employee', 'method', 'qr', 'reason', v_reason));
    return jsonb_build_object('ok', false, 'reason', 'not_allowed');
  end if;
  update private.signin_qr_codes set closed_at = now(), outcome = 'used' where id = r.id;
  select u.email into v_email from auth.users u where u.id = r.user_id;
  perform private.account_audit(r.company_id, 'account.qr_used', r.user_id, 'Signed in on a phone with a QR code', jsonb_build_object('kind', 'employee', 'method', 'qr'));
  return jsonb_build_object('ok', true, 'id', r.id, 'user_id', r.user_id, 'email', v_email);
end;
$$;
revoke all on function public.signin_qr_redeem(text) from public, anon, authenticated;
grant execute on function public.signin_qr_redeem(text) to service_role;

/** The server could not make the session after a code was used (recorded; the office shows a new code). */
create or replace function public.signin_qr_failed(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  r private.signin_qr_codes;
begin
  update private.signin_qr_codes q set outcome = 'failed' where q.id = p_id and q.outcome = 'used' returning * into r;
  if found then
    perform private.account_audit(r.company_id, 'account.qr_failed', r.user_id, 'Sign-in QR code used, but the phone could not be signed in',
      jsonb_build_object('kind', 'employee', 'method', 'qr'));
  end if;
end;
$$;
revoke all on function public.signin_qr_failed(uuid) from public, anon, authenticated;
grant execute on function public.signin_qr_failed(uuid) to service_role;

-- -----------------------------------------------------------------------------
-- Passkeys (face or fingerprint): company-side checks and audit
-- -----------------------------------------------------------------------------

/** May the caller remove this person's passkeys (lost phone)? Same rules as resetting their sign-in; never in a visit. */
create or replace function public.signin_passkey_check(p_user uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if private.support_company() is not null then
    raise exception 'Taviron support cannot change who can sign in to the company. Ask an owner of the company.' using errcode = '42501';
  end if;
  perform private.account_issue_allowed(p_user, 'employee');
end;
$$;
revoke all on function public.signin_passkey_check(uuid) from public, anon;
grant execute on function public.signin_passkey_check(uuid) to authenticated;

/** Record that the server removed this person's passkeys (after signin_passkey_check). */
create or replace function public.signin_passkeys_removed(p_user uuid, p_count integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid;
begin
  perform public.signin_passkey_check(p_user);
  v_company := private.require_company();
  perform private.account_audit(v_company, 'account.passkeys_removed', p_user, 'Face or fingerprint sign-in removed',
    jsonb_build_object('kind', 'employee', 'method', 'passkey', 'count', greatest(coalesce(p_count, 0), 0)));
end;
$$;
revoke all on function public.signin_passkeys_removed(uuid, integer) from public, anon;
grant execute on function public.signin_passkeys_removed(uuid, integer) to authenticated;

/** The signed-in person set up face or fingerprint sign-in on a device (recorded for their company's history). */
create or replace function public.my_passkey_added()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.current_company_id();
begin
  if auth.uid() is null then raise exception 'Sign in first.' using errcode = '42501'; end if;
  perform private.account_audit(v_company, 'account.passkey_added', auth.uid(), 'Face or fingerprint sign-in set up on a device',
    jsonb_build_object('kind', 'employee', 'method', 'passkey'));
end;
$$;
revoke all on function public.my_passkey_added() from public, anon;
grant execute on function public.my_passkey_added() to authenticated;
