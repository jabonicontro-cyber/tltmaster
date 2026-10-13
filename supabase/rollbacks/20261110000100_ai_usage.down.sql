-- Rollback of 20261110000100_ai_usage.sql (not a migration; run by hand with a backup first).
-- Removes the AI usage ledger. Every AI capability then reports Blocked ("usage ledger not available").
begin;
drop function if exists public.ai_usage_summary();
drop function if exists public.record_ai_usage(text, text, text, text, text, text, integer, integer, bigint, integer);
drop table if exists public.ai_usage_events;
commit;
