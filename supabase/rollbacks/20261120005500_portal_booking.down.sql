-- Rollback for 20261120005500_portal_booking.sql. Removes customer booking with its settings, capacity and requests.
begin;
drop function if exists public.demo_booking_samples();
drop function if exists public.portal_booking_cancel(text, uuid);
drop function if exists public.portal_booking_request(text, jsonb);
drop function if exists public.portal_booking_state(text);
drop function if exists public.booking_decide(uuid, text, text, uuid);
drop function if exists public.booking_set_capacity(date, integer);
drop function if exists public.booking_save_settings(boolean, integer, integer);
drop function if exists private.booking_used(uuid, date);
drop table if exists public.booking_requests;
drop table if exists public.booking_capacity;
drop table if exists public.booking_settings;
commit;
