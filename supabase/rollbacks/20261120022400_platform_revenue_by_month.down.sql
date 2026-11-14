-- Rollback of 20261120022400_platform_revenue_by_month.sql (not a migration; run by hand after a backup). Removes the
-- revenue-over-time read. No rows change.
begin;

drop function if exists public.platform_revenue_by_month(integer);
drop function if exists private.agreed_monthly_on(uuid, date);

commit;
