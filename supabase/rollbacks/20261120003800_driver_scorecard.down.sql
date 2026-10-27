-- Rollback for 20261120003800_driver_scorecard.sql: the read-only scorecard function; nothing was stored.
drop function if exists public.driver_scorecard(date, date, boolean);
