-- Rollback of 20261120019900_mfa_status_for_members.sql (not a migration; run by hand after a backup). Removes the
-- read-only function; Settings → Security then lists who must use two-step verification without who has set it up
-- (the page shows that state when the function is missing). No data is touched.
begin;
drop function if exists public.company_mfa_status();
commit;
