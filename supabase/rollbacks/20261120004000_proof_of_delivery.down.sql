-- Rollback for 20261120004000_proof_of_delivery.sql: submission positions and the portal proof functions.
drop function if exists public.demo_ticket_locations();
drop function if exists public.portal_ticket_photo(text, uuid);
drop function if exists public.portal_ticket_proof(text, uuid);
drop function if exists public.driver_record_ticket_location(uuid, numeric, numeric, numeric);
drop table if exists public.ticket_locations;
