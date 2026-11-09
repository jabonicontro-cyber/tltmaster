-- =============================================================================
-- Getting started: remember, per person and per company, that the "Getting started" checklist was put away.
--
-- 1. user_preferences accepts the key 'getting_started' (value {"dismissed_at": ...}).
-- 2. public.dismiss_getting_started(): records it for the caller in the current company. Idempotent; never touches
--    another person's row or another company. Works the same in every company (demo companies included).
--
-- Additive. Rollback: supabase/rollbacks/20261120014100_getting_started_dismiss.down.sql.
-- Without this migration the app remembers the dismissal in the browser (localStorage) only.
-- =============================================================================

alter table public.user_preferences drop constraint if exists user_preferences_key_check;
alter table public.user_preferences add constraint user_preferences_key_check
  check (key in ('command_center', 'demo_welcome', 'getting_started'));

create or replace function public.dismiss_getting_started()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
begin
  insert into public.user_preferences (company_id, user_id, key, value)
  values (v_company, auth.uid(), 'getting_started', jsonb_build_object('dismissed_at', now()))
  on conflict (company_id, user_id, key) do nothing;
end;
$$;

revoke execute on function public.dismiss_getting_started() from public, anon;
grant execute on function public.dismiss_getting_started() to authenticated;

-- Verification: the key is accepted and the function is pinned.
do $$
begin
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and p.proname = 'dismiss_getting_started'
                   and p.prosecdef and 'search_path=""' = any (p.proconfig)) then
    raise exception 'dismiss_getting_started is not installed as expected';
  end if;
end;
$$;
