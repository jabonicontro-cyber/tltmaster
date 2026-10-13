-- =============================================================================
-- AI usage ledger (docs/AI.md §6): one row per call to an AI model provider,
-- per company. Used for monthly token caps, per-minute rate limits and usage
-- reporting. Stores counts, timings and outcome only — never prompts, model
-- output, names or any other business content.
--
-- 1. public.ai_usage_events: append-only (no update/delete for app users);
--    readable by people with settings.manage in their own company.
-- 2. public.record_ai_usage(...): the only way to write a row; the company and
--    user come from the session, never from the caller. Idempotent per
--    request key.
-- 3. public.ai_usage_summary(): tokens used this calendar month (UTC) and
--    calls in the last minute, for the caller's company.
--
-- Additive. Rollback: supabase/rollbacks/20261110000100_ai_usage.down.sql.
-- Without this migration every AI capability stays Blocked ("usage ledger
-- not available"), so nothing is ever sent to a provider untracked.
-- =============================================================================

create table public.ai_usage_events (
  id bigint generated always as identity primary key,
  company_id uuid not null references public.companies (id) on delete cascade,
  user_id uuid references auth.users (id) on delete set null,
  request_key text not null check (request_key ~ '^[A-Za-z0-9_-]{8,80}$'),
  capability text not null check (capability ~ '^[a-z][a-z0-9_]{1,40}$'),
  provider text not null check (provider ~ '^[a-z][a-z0-9_]{1,30}$'),
  model text not null check (length(model) between 1 and 100),
  outcome text not null check (outcome in ('ok', 'error')),
  error_kind text check (error_kind is null or error_kind ~ '^[a-z_]{1,30}$'),
  -- Reported by the provider (null when it did not report them). Never estimated.
  input_tokens integer check (input_tokens is null or input_tokens >= 0),
  output_tokens integer check (output_tokens is null or output_tokens >= 0),
  -- Estimate from the configured price table, in millionths of a US dollar; null without a price.
  estimated_cost_micro_usd bigint check (estimated_cost_micro_usd is null or estimated_cost_micro_usd >= 0),
  latency_ms integer not null check (latency_ms >= 0),
  created_at timestamptz not null default now(),
  unique (company_id, request_key)
);

create index ai_usage_events_company_time on public.ai_usage_events (company_id, created_at desc);

alter table public.ai_usage_events enable row level security;

create policy ai_usage_events_select on public.ai_usage_events for select to authenticated
  using (company_id = (select private.current_company_id()) and (select private.has_permission('settings.manage')));

revoke all on public.ai_usage_events from anon, authenticated;
grant select on public.ai_usage_events to authenticated;

create or replace function public.record_ai_usage(
  p_request_key text, p_capability text, p_provider text, p_model text, p_outcome text, p_error_kind text,
  p_input_tokens integer, p_output_tokens integer, p_estimated_cost_micro_usd bigint, p_latency_ms integer
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
begin
  insert into public.ai_usage_events (company_id, user_id, request_key, capability, provider, model, outcome, error_kind,
    input_tokens, output_tokens, estimated_cost_micro_usd, latency_ms)
  values (v_company, auth.uid(), p_request_key, p_capability, p_provider, p_model, p_outcome, p_error_kind,
    p_input_tokens, p_output_tokens, p_estimated_cost_micro_usd, greatest(coalesce(p_latency_ms, 0), 0))
  on conflict (company_id, request_key) do nothing;
end;
$$;

create or replace function public.ai_usage_summary()
returns table (tokens_this_month bigint, calls_last_minute integer)
language sql
stable
security definer
set search_path = ''
as $$
  select
    coalesce(sum(coalesce(e.input_tokens, 0) + coalesce(e.output_tokens, 0)) filter (
      where e.created_at >= date_trunc('month', now() at time zone 'utc') at time zone 'utc'), 0)::bigint,
    (count(*) filter (where e.created_at > now() - interval '1 minute'))::integer
  from public.ai_usage_events e
  where e.company_id = private.require_company()
$$;

revoke execute on function public.record_ai_usage(text, text, text, text, text, text, integer, integer, bigint, integer) from public, anon;
grant execute on function public.record_ai_usage(text, text, text, text, text, text, integer, integer, bigint, integer) to authenticated;
revoke execute on function public.ai_usage_summary() from public, anon;
grant execute on function public.ai_usage_summary() to authenticated;

-- Verification: both functions are pinned and RLS is on.
do $$
begin
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname in ('record_ai_usage', 'ai_usage_summary')
        and p.prosecdef and 'search_path=""' = any (p.proconfig)) <> 2 then
    raise exception 'AI usage functions are not installed as expected';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.ai_usage_events'::regclass) then
    raise exception 'ai_usage_events must have row level security';
  end if;
end;
$$;
