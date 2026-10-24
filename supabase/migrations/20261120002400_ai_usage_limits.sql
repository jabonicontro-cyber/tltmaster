-- =============================================================================
-- AI per-person limits and the platform pause switch (docs/AI.md §6, §14).
--
-- 1. private.ai_controls: one row. `paused = true` stops every AI request on
--    every company at the next request, without a redeploy. Only the database
--    owner (Supabase SQL editor) can change it; app users cannot read or write
--    it directly.
-- 2. public.ai_usage_limits(): what the server needs before each AI request —
--    the caller's company totals (tokens and estimated cost this month, calls in
--    the last minute), the caller's own totals (tokens this month, calls in the
--    last minute and today) and the pause switch. Company and user come from the
--    session, never from the caller. Counts only; no prompts or answers exist
--    to read.
--
-- Additive. Rollback: supabase/rollbacks/20261120002400_ai_usage_limits.down.sql.
-- Without this migration the server cannot check per-person limits or the
-- pause switch, so every AI capability stays Blocked (fail closed).
-- =============================================================================

create table private.ai_controls (
  id boolean primary key default true check (id),
  paused boolean not null default false,
  reason text check (reason is null or length(reason) <= 200),
  updated_at timestamptz not null default now()
);

insert into private.ai_controls (id, paused) values (true, false) on conflict (id) do nothing;

revoke all on private.ai_controls from public, anon, authenticated;

create index if not exists ai_usage_events_company_user_time on public.ai_usage_events (company_id, user_id, created_at desc);

create or replace function public.ai_usage_limits()
returns table (
  tokens_this_month bigint,
  calls_last_minute integer,
  cost_this_month_micro_usd bigint,
  unpriced_calls_this_month integer,
  user_tokens_this_month bigint,
  user_calls_last_minute integer,
  user_calls_today integer,
  paused boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  with scope as (
    select private.require_company() as company, auth.uid() as uid,
           date_trunc('month', now() at time zone 'utc') at time zone 'utc' as month_start,
           date_trunc('day', now() at time zone 'utc') at time zone 'utc' as day_start
  )
  select
    coalesce(sum(coalesce(e.input_tokens, 0) + coalesce(e.output_tokens, 0)) filter (where e.created_at >= s.month_start), 0)::bigint,
    (count(e.id) filter (where e.created_at > now() - interval '1 minute'))::integer,
    coalesce(sum(e.estimated_cost_micro_usd) filter (where e.created_at >= s.month_start), 0)::bigint,
    (count(e.id) filter (where e.created_at >= s.month_start and e.estimated_cost_micro_usd is null and e.outcome = 'ok'))::integer,
    coalesce(sum(coalesce(e.input_tokens, 0) + coalesce(e.output_tokens, 0)) filter (where e.created_at >= s.month_start and e.user_id = s.uid), 0)::bigint,
    (count(e.id) filter (where e.created_at > now() - interval '1 minute' and e.user_id = s.uid))::integer,
    (count(e.id) filter (where e.created_at >= s.day_start and e.user_id = s.uid))::integer,
    coalesce((select c.paused from private.ai_controls c where c.id), true)
  from scope s
  left join public.ai_usage_events e on e.company_id = s.company and e.created_at >= least(s.month_start, now() - interval '1 minute')
  group by s.company, s.uid, s.month_start, s.day_start
$$;

revoke execute on function public.ai_usage_limits() from public, anon;
grant execute on function public.ai_usage_limits() to authenticated;

-- Verification: pinned definer function, locked-down switch table.
do $$
begin
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and p.proname = 'ai_usage_limits'
                   and p.prosecdef and 'search_path=""' = any (p.proconfig)) then
    raise exception 'ai_usage_limits is not installed as expected';
  end if;
  if has_table_privilege('authenticated', 'private.ai_controls', 'select') then
    raise exception 'private.ai_controls must not be readable by app users';
  end if;
end;
$$;
