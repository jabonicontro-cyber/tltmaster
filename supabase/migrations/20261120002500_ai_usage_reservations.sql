-- =============================================================================
-- AI usage limits enforced atomically (docs/AI.md §6; follows 20261120002400).
--
-- Before: the server read the usage summary, called the model, then recorded the
-- call. Two requests at the same moment could both pass a limit (per person per
-- minute or day, monthly tokens, the company's cost ceiling) before either was
-- recorded.
--
-- Now every model call is reserved first:
-- 1. public.ai_reserve_call(...) takes a per-company advisory lock, recomputes the
--    company's and the caller's usage including reservations still in flight,
--    checks the pause switch and every limit, and either refuses (returns the
--    reason) or inserts a 'reserved' row holding the call's projected tokens.
--    Concurrent reservations of one company queue on the lock, so each sees the
--    ones before it.
-- 2. public.record_ai_usage(...) finalizes the caller's own reservation with the
--    reported tokens, cost and outcome (same request key), instead of ignoring it.
-- 3. Totals count a reservation's projected tokens until it is finalized; one left
--    behind (the server stopped mid-call) stops counting tokens after 15 minutes
--    but still counts as a call.
--
-- The limits are passed by the server (they are environment settings). A member
-- calling this function directly can only refuse or reserve their own company's
-- calls; no model is reached without the server's key.
--
-- Additive. Rollback: supabase/rollbacks/20261120002500_ai_usage_reservations.down.sql.
-- =============================================================================

alter table public.ai_usage_events drop constraint ai_usage_events_outcome_check;
alter table public.ai_usage_events add constraint ai_usage_events_outcome_check check (outcome in ('ok', 'error', 'reserved'));
alter table public.ai_usage_events add column if not exists reserved_tokens integer check (reserved_tokens is null or reserved_tokens between 0 and 1000000);

-- Company and caller totals; reservations in flight count with their projected tokens.
create or replace function private.ai_usage_totals(p_company uuid, p_user uuid)
returns table (
  tokens_this_month bigint, calls_last_minute integer, cost_this_month_micro_usd bigint, unpriced_calls_this_month integer,
  user_tokens_this_month bigint, user_calls_last_minute integer, user_calls_today integer
)
language sql
stable
security definer
set search_path = ''
as $$
  with b as (
    select date_trunc('month', now() at time zone 'utc') at time zone 'utc' as month_start,
           date_trunc('day', now() at time zone 'utc') at time zone 'utc' as day_start
  ), e as (
    select ev.*, case
             when ev.outcome = 'reserved' then case when ev.created_at > now() - interval '15 minutes' then coalesce(ev.reserved_tokens, 0) else 0 end
             else coalesce(ev.input_tokens, 0) + coalesce(ev.output_tokens, 0)
           end as tokens
    from public.ai_usage_events ev, b
    where ev.company_id = p_company and ev.created_at >= least(b.month_start, now() - interval '1 minute')
  )
  select
    coalesce(sum(e.tokens) filter (where e.created_at >= b.month_start), 0)::bigint,
    (count(e.id) filter (where e.created_at > now() - interval '1 minute'))::integer,
    coalesce(sum(e.estimated_cost_micro_usd) filter (where e.created_at >= b.month_start), 0)::bigint,
    (count(e.id) filter (where e.created_at >= b.month_start and e.estimated_cost_micro_usd is null and e.outcome = 'ok'))::integer,
    coalesce(sum(e.tokens) filter (where e.created_at >= b.month_start and e.user_id = p_user), 0)::bigint,
    (count(e.id) filter (where e.created_at > now() - interval '1 minute' and e.user_id = p_user))::integer,
    (count(e.id) filter (where e.created_at >= b.day_start and e.user_id = p_user))::integer
  from b left join e on true
  group by b.month_start, b.day_start
$$;

revoke all on function private.ai_usage_totals(uuid, uuid) from public, anon, authenticated;

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
  select t.*, coalesce((select c.paused from private.ai_controls c where c.id), true)
  from private.ai_usage_totals(private.require_company(), auth.uid()) t
$$;

create or replace function public.ai_reserve_call(
  p_request_key text, p_capability text, p_provider text, p_model text, p_reserve_tokens integer,
  p_monthly_tokens bigint, p_per_minute integer, p_monthly_cost_micro_usd bigint,
  p_user_monthly_tokens bigint, p_user_per_minute integer, p_user_daily integer
)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v_user    uuid := auth.uid();
  t         record;
begin
  if p_reserve_tokens is null or p_reserve_tokens < 1 or p_reserve_tokens > 1000000
     or coalesce(p_monthly_tokens, 0) < 1 or coalesce(p_user_monthly_tokens, 0) < 1
     or coalesce(p_per_minute, 0) < 1 or coalesce(p_user_per_minute, 0) < 1 or coalesce(p_user_daily, 0) < 1 then
    raise exception 'Invalid AI reservation.' using errcode = '22023';
  end if;
  -- One reservation at a time per company: the next one sees this one once it commits.
  perform pg_advisory_xact_lock(hashtextextended('ai_usage:' || v_company::text, 0));
  if coalesce((select c.paused from private.ai_controls c where c.id), true) then return 'paused'; end if;
  select * into t from private.ai_usage_totals(v_company, v_user);
  if t.user_calls_last_minute >= p_user_per_minute then return 'user_per_minute'; end if;
  if t.user_calls_today >= p_user_daily then return 'user_daily'; end if;
  if t.calls_last_minute >= p_per_minute then return 'company_per_minute'; end if;
  if p_monthly_cost_micro_usd is not null and t.cost_this_month_micro_usd >= p_monthly_cost_micro_usd then return 'company_cost'; end if;
  if t.tokens_this_month + p_reserve_tokens > p_monthly_tokens then return 'company_tokens'; end if;
  if t.user_tokens_this_month + p_reserve_tokens > p_user_monthly_tokens then return 'user_tokens'; end if;
  insert into public.ai_usage_events (company_id, user_id, request_key, capability, provider, model, outcome, reserved_tokens, latency_ms)
  values (v_company, v_user, p_request_key, p_capability, p_provider, p_model, 'reserved', p_reserve_tokens, 0);
  return 'ok';
end;
$$;

-- Recording a call finalizes the caller's own reservation (same request key); otherwise it inserts as before.
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
  if p_outcome not in ('ok', 'error') then
    raise exception 'Invalid AI usage outcome.' using errcode = '22023';
  end if;
  insert into public.ai_usage_events (company_id, user_id, request_key, capability, provider, model, outcome, error_kind,
    input_tokens, output_tokens, estimated_cost_micro_usd, latency_ms)
  values (v_company, auth.uid(), p_request_key, p_capability, p_provider, p_model, p_outcome, p_error_kind,
    p_input_tokens, p_output_tokens, p_estimated_cost_micro_usd, greatest(coalesce(p_latency_ms, 0), 0))
  on conflict (company_id, request_key) do update
    set outcome = excluded.outcome, error_kind = excluded.error_kind, input_tokens = excluded.input_tokens,
        output_tokens = excluded.output_tokens, estimated_cost_micro_usd = excluded.estimated_cost_micro_usd,
        latency_ms = excluded.latency_ms, model = excluded.model
    where public.ai_usage_events.outcome = 'reserved' and public.ai_usage_events.user_id is not distinct from auth.uid();
end;
$$;

revoke execute on function public.ai_reserve_call(text, text, text, text, integer, bigint, integer, bigint, bigint, integer, integer) from public, anon;
grant execute on function public.ai_reserve_call(text, text, text, text, integer, bigint, integer, bigint, bigint, integer, integer) to authenticated;
revoke execute on function public.ai_usage_limits() from public, anon;
grant execute on function public.ai_usage_limits() to authenticated;
revoke execute on function public.record_ai_usage(text, text, text, text, text, text, integer, integer, bigint, integer) from public, anon;
grant execute on function public.record_ai_usage(text, text, text, text, text, text, integer, integer, bigint, integer) to authenticated;

do $$
begin
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where (n.nspname, p.proname) in (('public', 'ai_reserve_call'), ('public', 'record_ai_usage'), ('public', 'ai_usage_limits'), ('private', 'ai_usage_totals'))
        and p.prosecdef and 'search_path=""' = any (p.proconfig)) <> 4 then
    raise exception 'AI usage functions are not installed as expected';
  end if;
end;
$$;
