-- Rollback of 20261120020700_security_overview.sql (not a migration; run by hand after a backup). Removes the security overview read. No rows change.
begin;

drop function if exists public.platform_security_overview();

commit;
