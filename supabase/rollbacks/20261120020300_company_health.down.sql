-- Rollback of 20261120020300_company_health.sql (not a migration; run by hand after a backup). Removes the company health read. No rows change.
begin;

drop function if exists public.platform_company_health(uuid);
-- After 20261120020400 is rolled back (platform_company_usage uses it).
drop function if exists private.platform_staff_may_see(uuid);

commit;
