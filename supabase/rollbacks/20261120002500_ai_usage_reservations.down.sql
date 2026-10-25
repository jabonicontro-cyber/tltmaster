-- Rollback of 20261120002500_ai_usage_reservations.sql (not a migration; run by hand with a backup first).
-- Restores record_ai_usage and ai_usage_limits as of 20261120002400 and removes reservations. Without
-- ai_reserve_call the server refuses every AI request (fail closed) until the migration is applied again.
begin;
drop function if exists public.ai_reserve_call(text, text, text, text, integer, bigint, integer, bigint, bigint, integer, integer);

-- Reservations that were never finalized are removed; finalized rows are ordinary 'ok'/'error' rows.
delete from public.ai_usage_events where outcome = 'reserved';
alter table public.ai_usage_events drop constraint ai_usage_events_outcome_check;
alter table public.ai_usage_events add constraint ai_usage_events_outcome_check check (outcome in ('ok', 'error'));
alter table public.ai_usage_events drop column if exists reserved_tokens;

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

create or replace function public.ai_usage_limits()
returns table (
  tokens_this_month bigint, calls_last_minute integer, cost_this_month_micro_usd bigint, unpriced_calls_this_month integer,
  user_tokens_this_month bigint, user_calls_last_minute integer, user_calls_today integer, paused boolean
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

drop function if exists private.ai_usage_totals(uuid, uuid);
commit;
