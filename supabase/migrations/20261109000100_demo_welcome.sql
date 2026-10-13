-- =============================================================================
-- Demo welcome: remember, per person and per demo company, that the welcome
-- dialog was seen (docs/DEMO_TENANTS.md §2).
--
-- 1. user_preferences accepts the key 'demo_welcome' (value {"seen_at": …}).
-- 2. public.dismiss_demo_welcome(): records it for the caller in the current
--    company, only when that company is a demo. Idempotent; never changes
--    another person's row or a real company.
--
-- Additive. Rollback: supabase/rollbacks/20261109000100_demo_welcome.down.sql.
-- Without this migration the app remembers the dismissal in a browser cookie.
-- =============================================================================

alter table public.user_preferences drop constraint if exists user_preferences_key_check;
alter table public.user_preferences add constraint user_preferences_key_check
  check (key in ('command_center', 'demo_welcome'));

create or replace function public.dismiss_demo_welcome()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
begin
  if not exists (select 1 from public.companies c where c.id = v_company and c.is_demo) then
    raise exception 'Only demo companies have a welcome.' using errcode = '22023';
  end if;
  insert into public.user_preferences (company_id, user_id, key, value)
  values (v_company, auth.uid(), 'demo_welcome', jsonb_build_object('seen_at', now()))
  on conflict (company_id, user_id, key) do nothing;
end;
$$;

revoke execute on function public.dismiss_demo_welcome() from public, anon;
grant execute on function public.dismiss_demo_welcome() to authenticated;

-- Verification: the key is accepted and the function is pinned.
do $$
begin
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and p.proname = 'dismiss_demo_welcome'
                   and p.prosecdef and 'search_path=""' = any (p.proconfig)) then
    raise exception 'dismiss_demo_welcome is not installed as expected';
  end if;
end;
$$;
