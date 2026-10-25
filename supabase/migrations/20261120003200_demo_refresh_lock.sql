-- =============================================================================
-- One demo refresh at a time, manual or automatic (fix for 20261120002800).
--
-- The automatic refresh already took a lock in private.demo_refresh_state, but Admin → Demo → "Refresh demo data" did
-- not, so a manual refresh started just after a deployment could run at the same time as the automatic one and both
-- would try to add the same sample (seen as "duplicate key value violates unique constraint drivers_user_key").
--
-- * public.demo_refresh_begin(): the manual refresh takes the same lock (ignoring version, day and the failure wait);
--   false while another refresh of this demo is running (one older than 15 minutes counts as abandoned).
-- * public.demo_refresh_end(version, day, ok): releases it; on success the demo counts as current for this version
--   and day so the automatic refresh does not repeat the work. Logging stays with the manual action (recordRefresh).
--
-- Same caller rule as the automatic refresh: the current company is an active demo and the caller its active owner.
-- Reversible: supabase/rollbacks/20261120003200_demo_refresh_lock.down.sql
-- =============================================================================

create or replace function public.demo_refresh_begin()
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_demo uuid := private.demo_owner_company();
begin
  if v_demo is null then
    return false;
  end if;
  insert into private.demo_refresh_state (company_id) values (v_demo) on conflict (company_id) do nothing;
  update private.demo_refresh_state
     set started_at = now(), finished_at = null
   where company_id = v_demo
     and (started_at is null or finished_at is not null or started_at < now() - interval '15 minutes');
  return found;
end;
$$;
revoke all on function public.demo_refresh_begin() from public, anon;
grant execute on function public.demo_refresh_begin() to authenticated;

create or replace function public.demo_refresh_end(p_version text, p_day date, p_ok boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_demo uuid := private.demo_owner_company();
begin
  if v_demo is null then
    return;
  end if;
  update private.demo_refresh_state
     set finished_at = now(), ok = coalesce(p_ok, false), summary = 'Manual refresh',
         version = case when p_ok and p_version is not null then left(p_version, 80) else version end,
         refreshed_on = case when p_ok and p_day is not null then p_day else refreshed_on end
   where company_id = v_demo and started_at is not null and finished_at is null;
end;
$$;
revoke all on function public.demo_refresh_end(text, date, boolean) from public, anon;
grant execute on function public.demo_refresh_end(text, date, boolean) to authenticated;
