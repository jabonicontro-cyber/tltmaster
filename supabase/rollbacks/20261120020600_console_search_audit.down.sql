-- Rollback of 20261120020600_console_search_audit.sql (not a migration; run by hand after a backup). Removes console search and the filtered audit log reads. No rows
-- change.
begin;

drop function if exists public.platform_audit_facets();
drop function if exists public.platform_audit_search(uuid, text, uuid, date, date, bigint, integer);
drop function if exists public.platform_search(text);

commit;
