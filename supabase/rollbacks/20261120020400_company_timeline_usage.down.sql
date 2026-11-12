-- Rollback of 20261120020400_company_timeline_usage.sql (not a migration; run by hand after a backup). Removes the company timeline and usage reads. No rows change.
begin;

drop function if exists public.platform_company_timeline(uuid, timestamptz, integer);
drop function if exists public.platform_company_usage(uuid, integer);

commit;
