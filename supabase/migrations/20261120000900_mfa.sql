-- =============================================================================
-- Two-step verification (MFA) — Supabase Auth TOTP factors and assurance levels (aal1/aal2), plus what Auth does not
-- provide: one-time recovery codes, a company policy, rate limiting and security events.
--
--   * Platform administrators must use MFA: private.require_platform_admin() refuses a session below aal2. Emergency
--     switch for the database owner only (SQL, audited by nature of direct access): private.platform_settings key
--     'platform_mfa_enforced' = 'false'. There is no app path that turns it off.
--   * A company may require MFA for everyone in it (company_settings.require_mfa, owner/settings.manage). The app
--     enforces it on every page and action of that company (src/server/auth.ts).
--   * Recovery codes: 10 per generation, shown once, stored as sha256 hashes, single use, all replaced on regeneration.
--     Generating requires an aal2 session (step-up). Redeeming a code proves the second factor: the server then removes
--     the person's TOTP factors through the Auth admin API, and the person must enroll a new one before continuing.
--     A password reset never removes a factor.
--   * Failed recovery attempts are limited (5 per 15 minutes per person) and every MFA event is recorded.
-- Rollback: supabase/rollbacks/20261120000900_mfa.down.sql
-- =============================================================================

create table private.mfa_recovery_codes (
  user_id    uuid not null references auth.users (id) on delete cascade,
  code_hash  text not null,
  created_at timestamptz not null default now(),
  used_at    timestamptz,
  primary key (user_id, code_hash)
);
revoke all on private.mfa_recovery_codes from public, anon, authenticated;

create table private.mfa_attempts (
  user_id uuid not null references auth.users (id) on delete cascade,
  at      timestamptz not null default now(),
  ok      boolean not null
);
create index mfa_attempts_lookup on private.mfa_attempts (user_id, at desc);
revoke all on private.mfa_attempts from public, anon, authenticated;

create table private.security_events (
  id      bigint generated always as identity primary key,
  user_id uuid references auth.users (id) on delete cascade,
  event   text not null check (event ~ '^[a-z_.]{1,60}$'),
  detail  jsonb not null default '{}'::jsonb,
  at      timestamptz not null default now()
);
create index security_events_user on private.security_events (user_id, at desc);
revoke all on private.security_events from public, anon, authenticated;

alter table public.company_settings add column if not exists require_mfa boolean not null default false;

create or replace function private.aal2()
 returns boolean
 language sql
 stable
 set search_path to ''
as $$
  select coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2';
$$;
revoke all on function private.aal2() from public, anon, authenticated;

create or replace function private.security_log(p_event text, p_detail jsonb default '{}'::jsonb)
 returns void
 language sql
 security definer
 set search_path to ''
as $$
  insert into private.security_events (user_id, event, detail) values (auth.uid(), p_event, coalesce(p_detail, '{}'::jsonb));
$$;
revoke all on function private.security_log(text, jsonb) from public, anon, authenticated;

create or replace function private.platform_mfa_enforced()
 returns boolean
 language sql
 stable
 security definer
 set search_path to ''
as $$
  select coalesce((select value <> 'false' from private.platform_settings where key = 'platform_mfa_enforced'), true);
$$;
revoke all on function private.platform_mfa_enforced() from public, anon, authenticated;

-- Platform functions: a platform admin, and (unless the database owner switched it off) a verified second factor.
create or replace function private.require_platform_admin()
 returns uuid
 language plpgsql
 stable
 security definer
 set search_path to ''
as $$
begin
  if not private.is_platform_admin() then
    raise exception 'Not available.' using errcode = '42501';
  end if;
  if private.platform_mfa_enforced() and not private.aal2() then
    raise exception 'Two-step verification is required for the platform console.' using errcode = '42501';
  end if;
  return auth.uid();
end;
$$;

-- Does this person have to use MFA, and why? (Platform admin, or any active company of theirs requires it.)
create or replace function public.mfa_policy()
 returns jsonb
 language sql
 stable
 security definer
 set search_path to ''
as $$
  select jsonb_build_object(
    'platform', private.is_platform_admin() and private.platform_mfa_enforced(),
    'companies', coalesce((select jsonb_agg(c.name order by c.name)
                           from public.company_memberships m
                           join public.companies c on c.id = m.company_id and c.active
                           join public.company_settings s on s.company_id = c.id
                           where m.user_id = auth.uid() and m.active and s.require_mfa), '[]'::jsonb),
    'current_company', coalesce((select s.require_mfa from public.company_settings s where s.company_id = private.current_company_id()), false),
    'recovery_codes', (select count(*) from private.mfa_recovery_codes r where r.user_id = auth.uid() and r.used_at is null),
    'recent_failures', (select count(*) from private.mfa_attempts a where a.user_id = auth.uid() and not a.ok and a.at > now() - interval '15 minutes'),
    'aal2', private.aal2());
$$;

create or replace function public.set_company_mfa_policy(p_required boolean)
 returns void
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  v_company uuid := private.require_company();
begin
  perform private.require_permission('settings.manage');
  -- Turning it on from a session without MFA would lock the person out of their own change.
  if p_required and not private.aal2() then
    raise exception 'Set up two-step verification for your own account first (My profile → Security).' using errcode = '42501';
  end if;
  update public.company_settings set require_mfa = coalesce(p_required, false) where company_id = v_company;
  perform private.log_event('security.mfa_policy', 'company', v_company,
    case when p_required then 'Two-step verification required for everyone' else 'Two-step verification no longer required' end, '{}'::jsonb);
  perform private.security_log('mfa.company_policy', jsonb_build_object('company_id', v_company, 'required', p_required));
end;
$$;

-- New recovery codes (replaces all earlier ones). Shown once; needs a verified second factor in this session.
create or replace function public.mfa_recovery_generate()
 returns text[]
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  v_codes text[] := '{}';
  v_code text;
begin
  if auth.uid() is null or not private.aal2() then
    raise exception 'Verify with your authenticator app first.' using errcode = '42501';
  end if;
  delete from private.mfa_recovery_codes where user_id = auth.uid();
  for i in 1..10 loop
    -- 10 characters from a random UUID (about 40 random bits each), shown as xxxxx-xxxxx.
    v_code := substr(replace(gen_random_uuid()::text, '-', ''), 1, 5) || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 5);
    v_codes := array_append(v_codes, v_code);
    insert into private.mfa_recovery_codes (user_id, code_hash) values (auth.uid(), encode(sha256(convert_to(v_code, 'UTF8')), 'hex'));
  end loop;
  perform private.security_log('mfa.recovery_generated', '{}'::jsonb);
  return v_codes;
end;
$$;

-- Redeem a recovery code (signed in with the password, no second factor). True once per valid unused code.
create or replace function public.mfa_recovery_redeem(p_code text)
 returns boolean
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  v_code text := lower(regexp_replace(coalesce(p_code, ''), '[^0-9a-fA-F]', '', 'g'));
  v_hash text;
begin
  if auth.uid() is null then
    raise exception 'Sign in first.' using errcode = '42501';
  end if;
  if (select count(*) from private.mfa_attempts a where a.user_id = auth.uid() and not a.ok and a.at > now() - interval '15 minutes') >= 5 then
    -- (Not logged: the exception rolls the statement back. The failures before it are recorded.)
    raise exception 'Too many attempts. Wait 15 minutes, or ask your administrator.' using errcode = '54000';
  end if;
  if length(v_code) = 10 then
    v_hash := encode(sha256(convert_to(substr(v_code, 1, 5) || '-' || substr(v_code, 6, 5), 'UTF8')), 'hex');
    update private.mfa_recovery_codes set used_at = now()
    where user_id = auth.uid() and code_hash = v_hash and used_at is null;
    if found then
      insert into private.mfa_attempts (user_id, ok) values (auth.uid(), true);
      perform private.security_log('mfa.recovery_used', jsonb_build_object('remaining',
        (select count(*) from private.mfa_recovery_codes r where r.user_id = auth.uid() and r.used_at is null)));
      return true;
    end if;
  end if;
  insert into private.mfa_attempts (user_id, ok) values (auth.uid(), false);
  perform private.security_log('mfa.recovery_failed', '{}'::jsonb);
  return false;
end;
$$;

-- Record an MFA event the app observed (enrolled, verified, removed). Only these names; only about the caller.
create or replace function public.mfa_record_event(p_event text)
 returns void
 language plpgsql
 security definer
 set search_path to ''
as $$
begin
  if auth.uid() is null or p_event not in ('mfa.enrolled', 'mfa.verified', 'mfa.removed', 'mfa.challenge_failed') then
    raise exception 'Not available.' using errcode = '42501';
  end if;
  if p_event = 'mfa.challenge_failed' then
    insert into private.mfa_attempts (user_id, ok) values (auth.uid(), false);
  end if;
  perform private.security_log(p_event, jsonb_build_object('aal', coalesce(auth.jwt() ->> 'aal', 'aal1')));
end;
$$;

create or replace function public.my_security_events()
 returns jsonb
 language sql
 stable
 security definer
 set search_path to ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('event', e.event, 'at', e.at) order by e.at desc), '[]'::jsonb)
  from (select * from private.security_events where user_id = auth.uid() order by at desc limit 20) e;
$$;

do $$
declare f text;
begin
  foreach f in array array['public.mfa_policy()', 'public.set_company_mfa_policy(boolean)', 'public.mfa_recovery_generate()',
                           'public.mfa_recovery_redeem(text)', 'public.mfa_record_event(text)', 'public.my_security_events()']
  loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
