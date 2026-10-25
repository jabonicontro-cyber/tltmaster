-- =============================================================================
-- Demos refresh themselves (owner 2026-10-25): no more clicking "Refresh demo data" after each update.
--
-- When a demo owner (the platform team or a prospect's owner login) opens a demo company, the app refreshes its sample
-- data in the background once per deployed version and once per day (today's loads), using the same additive,
-- idempotent refresh as the button. This table records the last run per demo so only one runs at a time:
--
-- * public.demo_auto_refresh_claim(version, day): true when this caller should run the refresh now — the current company
--   is an active demo, the caller is its active owner, the demo is not yet at this version and day, no run is in
--   progress (a run older than 15 minutes counts as abandoned), and the last failure is at least an hour old.
-- * public.demo_auto_refresh_finish(version, day, ok, summary): records the outcome (version and day only on success)
--   and logs it to the platform activity like a manual refresh.
--
-- Real companies are never touched. Reversible: supabase/rollbacks/20261120002800_demo_auto_refresh.down.sql
-- =============================================================================

create table private.demo_refresh_state (
  company_id   uuid primary key references public.companies (id) on delete cascade,
  version      text not null default '',
  refreshed_on date,
  started_at   timestamptz,
  finished_at  timestamptz,
  ok           boolean,
  summary      text not null default ''
);
revoke all on private.demo_refresh_state from public, anon, authenticated;

-- The current company when it is an active demo and the caller is its active owner; else null.
create or replace function private.demo_owner_company()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select c.id
  from public.companies c
  join public.company_memberships m on m.company_id = c.id and m.user_id = auth.uid() and m.active and m.role = 'owner'
  where c.id = private.current_company_id() and c.is_demo and c.active;
$$;
revoke all on function private.demo_owner_company() from public, anon, authenticated;

create or replace function public.demo_auto_refresh_claim(p_version text, p_day date)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_demo uuid := private.demo_owner_company();
  v_version text := left(coalesce(p_version, ''), 80);
begin
  if v_demo is null or p_day is null or p_day not between current_date - 2 and current_date + 2 then
    return false;
  end if;
  insert into private.demo_refresh_state (company_id) values (v_demo) on conflict (company_id) do nothing;
  update private.demo_refresh_state
     set started_at = now(), finished_at = null
   where company_id = v_demo
     and (version is distinct from v_version or refreshed_on is distinct from p_day)
     and (started_at is null or finished_at is not null or started_at < now() - interval '15 minutes')
     and (ok is distinct from false or finished_at < now() - interval '1 hour');
  return found;
end;
$$;
revoke all on function public.demo_auto_refresh_claim(text, date) from public, anon;
grant execute on function public.demo_auto_refresh_claim(text, date) to authenticated;

create or replace function public.demo_auto_refresh_finish(p_version text, p_day date, p_ok boolean, p_summary text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_demo uuid := private.demo_owner_company();
  v_summary text := left(coalesce(p_summary, ''), 300);
begin
  if v_demo is null then
    return;
  end if;
  update private.demo_refresh_state
     set finished_at = now(), ok = coalesce(p_ok, false), summary = v_summary,
         version = case when p_ok then left(coalesce(p_version, ''), 80) else version end,
         refreshed_on = case when p_ok then p_day else refreshed_on end
   where company_id = v_demo and started_at is not null and finished_at is null;
  if found then
    perform private.platform_log(case when p_ok then 'demo_refreshed' else 'demo_refresh_failed' end, 'company', v_demo::text,
                                 'Automatic: ' || v_summary,
                                 jsonb_build_object('company_name', (select name from public.companies where id = v_demo), 'automatic', true));
  end if;
end;
$$;
revoke all on function public.demo_auto_refresh_finish(text, date, boolean, text) from public, anon;
grant execute on function public.demo_auto_refresh_finish(text, date, boolean, text) to authenticated;
