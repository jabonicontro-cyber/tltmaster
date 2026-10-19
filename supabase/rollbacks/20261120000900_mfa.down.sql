-- Rollback of 20261120000900_mfa: removes recovery codes, the company MFA policy and security events, and restores
-- private.require_platform_admin() without the second-factor check. Supabase Auth factors are not touched (people
-- keep their authenticator apps; nothing requires them any more). Run only with a backup in hand.
drop function if exists public.my_security_events();
drop function if exists public.mfa_record_event(text);
drop function if exists public.mfa_recovery_redeem(text);
drop function if exists public.mfa_recovery_generate();
drop function if exists public.set_company_mfa_policy(boolean);
drop function if exists public.mfa_policy();

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

drop function if exists private.platform_mfa_enforced();
drop function if exists private.security_log(text, jsonb);
drop function if exists private.aal2();
alter table public.company_settings drop column if exists require_mfa;
drop table if exists private.security_events;
drop table if exists private.mfa_attempts;
drop table if exists private.mfa_recovery_codes;
