-- Rollback of 20261120020300_company_health.sql (not a migration; run by hand after a backup). Removes the company health read. No rows change.
begin;

drop function if exists public.platform_company_health(uuid);

commit;
