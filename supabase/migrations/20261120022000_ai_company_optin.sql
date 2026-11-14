-- =============================================================================
-- Ask Taviron: the company's choice and the first-use notice (master plan §11a, docs/AI.md §15b).
--
-- Before Ask Taviron can answer anyone in a company, two things must be true, in addition to every existing switch,
-- limit and evaluation (src/server/ai/gates.ts):
--   1. The company allowed it: company_settings.ai_assistant_allowed (default off). Changed only through
--      public.set_ai_assistant_allowed by someone with settings.manage in their own company, never during a Taviron
--      support visit (the choice to send pseudonymized questions to the AI provider is the company's own). Who and when
--      are kept on the row and the change is in the audit log (the existing company_settings audit trigger).
--   2. The person read the first-use notice: user_preferences key 'ai_notice' (value {"version": n, "acknowledged_at"}),
--      recorded by public.acknowledge_ai_notice for the caller in the current company only. A newer notice version
--      shows the notice again (the app compares the version).
-- The same rules apply in demo companies (no demo branch; demos start with it off like every company).
--
-- Additive. Rollback: supabase/rollbacks/20261120022000_ai_company_optin.down.sql.
-- Without this migration Ask Taviron stays Blocked ("needs a database update"), fail closed.
-- =============================================================================

alter table public.company_settings
  add column if not exists ai_assistant_allowed boolean not null default false,
  add column if not exists ai_assistant_changed_at timestamptz,
  add column if not exists ai_assistant_changed_by uuid references auth.users (id) on delete set null;
comment on column public.company_settings.ai_assistant_allowed is
  'Ask Taviron allowed for this company (default off). Changed only through public.set_ai_assistant_allowed (settings.manage, no support visit).';
-- No column grant: the columns are read with the row (company_settings_read) and written only by the function below.

alter table public.user_preferences drop constraint if exists user_preferences_key_check;
alter table public.user_preferences add constraint user_preferences_key_check
  check (key in ('command_center', 'demo_welcome', 'getting_started', 'ai_notice'));

-- Allow or stop Ask Taviron for the caller's own company. Returns the new value.
create or replace function public.set_ai_assistant_allowed(p_allowed boolean)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
begin
  if p_allowed is null then
    raise exception 'Choose on or off.' using errcode = '22023';
  end if;
  if private.support_company() is not null then
    raise exception 'Only an owner of the company can choose whether Ask Taviron is used, not a Taviron support visit.' using errcode = '42501';
  end if;
  if not private.has_permission('settings.manage') then
    raise exception 'You do not have permission to change company settings.' using errcode = '42501';
  end if;
  update public.company_settings
     set ai_assistant_allowed = p_allowed, ai_assistant_changed_at = now(), ai_assistant_changed_by = auth.uid()
   where company_id = v_company;
  if not found then
    raise exception 'Company settings not found.' using errcode = 'P0002';
  end if;
  return p_allowed;
end;
$$;
revoke all on function public.set_ai_assistant_allowed(boolean) from public, anon;
grant execute on function public.set_ai_assistant_allowed(boolean) to authenticated;

-- Record that the caller read the first-use notice (version p_version) in the current company. Idempotent; a lower or
-- equal version never replaces a newer record. Members only (a support visitor is not a member and is refused).
create or replace function public.acknowledge_ai_notice(p_version integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
begin
  if p_version is null or p_version < 1 or p_version > 1000 then
    raise exception 'Unknown notice version.' using errcode = '22023';
  end if;
  if private.support_company() is not null or not exists (
    select 1 from public.company_memberships m
    where m.company_id = v_company and m.user_id = auth.uid() and m.active
  ) then
    raise exception 'Only people of this company can use Ask Taviron.' using errcode = '42501';
  end if;
  insert into public.user_preferences (company_id, user_id, key, value)
  values (v_company, auth.uid(), 'ai_notice', jsonb_build_object('version', p_version, 'acknowledged_at', now()))
  on conflict (company_id, user_id, key) do update
    set value = excluded.value, updated_at = now()
    where coalesce((public.user_preferences.value ->> 'version')::int, 0) < p_version;
end;
$$;
revoke all on function public.acknowledge_ai_notice(integer) from public, anon;
grant execute on function public.acknowledge_ai_notice(integer) to authenticated;

-- Verification: columns, key and pinned functions.
do $$
begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'company_settings' and column_name = 'ai_assistant_allowed') then
    raise exception 'company_settings.ai_assistant_allowed is missing';
  end if;
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname in ('set_ai_assistant_allowed', 'acknowledge_ai_notice')
        and p.prosecdef and 'search_path=""' = any (p.proconfig)) <> 2 then
    raise exception 'Ask Taviron opt-in functions are not installed as expected';
  end if;
end;
$$;
