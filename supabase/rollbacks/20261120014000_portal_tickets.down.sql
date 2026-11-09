-- Rollback of 20261120014000_portal_tickets.sql (not a migration; run by hand with a backup first).
-- Removes the portal ticket list function. The portal's Tickets page then shows "not available yet" and the CSV
-- download answers 404; every other portal page is unchanged.
begin;
drop function if exists public.portal_tickets(text, date, date, uuid);
commit;
