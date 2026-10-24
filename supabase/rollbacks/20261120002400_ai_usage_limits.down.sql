-- Rollback of 20261120002400_ai_usage_limits.sql (not a migration; run by hand with a backup first).
-- Removes the per-person usage summary and the pause switch. Every AI capability then reports Blocked
-- ("usage ledger not available"): the server never sends a request it cannot check against the limits.
begin;
drop function if exists public.ai_usage_limits();
drop index if exists public.ai_usage_events_company_user_time;
drop table if exists private.ai_controls;
commit;
