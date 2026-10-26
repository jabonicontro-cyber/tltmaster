-- Rollback of 20261120003700_hired_trucks.sql (not a migration; run by hand with a backup first).
-- Removes hired trucks: offers, hauler documents, haulers, the hauler links on trucks and drivers (the truck and driver
-- records themselves stay, as ordinary records), the assignment guard and the add-on switch. Assignments already
-- confirmed from offers stay as ordinary assignments.
begin;
drop trigger if exists dispatch_assignments_hired_guard on public.dispatch_assignments;
drop function if exists private.guard_hired_assignment();
drop function if exists public.hauler_offer_confirm(uuid);
drop function if exists public.hauler_offer_withdraw(uuid, text);
drop function if exists public.hauler_offer_respond(uuid, boolean, text);
drop function if exists public.hauler_offer_send(uuid, uuid, uuid, uuid, integer, text, text);
drop table if exists public.hauler_offers;
drop function if exists public.my_hauler_offers();
drop function if exists private.my_driver_id();
drop function if exists public.hauler_record_document(uuid, uuid, text, text, date);
drop function if exists public.hauler_add_driver(uuid, text, text);
drop function if exists public.hauler_add_truck(uuid, text, public.truck_type, text);
drop function if exists public.hauler_save(uuid, text, text, text, text, text, boolean);
drop function if exists private.require_hired_trucks();
drop function if exists private.hauler_document_problems(uuid, uuid, uuid, date);
alter table public.drivers drop constraint if exists drivers_hauler_fk;
alter table public.drivers drop column if exists hauler_id;
alter table public.trucks drop constraint if exists trucks_hauler_fk;
alter table public.trucks drop column if exists hauler_id;
drop table if exists public.hauler_documents;
drop table if exists public.haulers;
drop function if exists public.platform_hired_trucks_entitlement(uuid);
drop function if exists public.platform_hired_trucks_set(uuid, boolean, text);
drop function if exists public.hired_trucks_enabled();
drop function if exists private.hired_trucks_on(uuid);
drop table if exists private.hired_trucks_entitlements;
commit;
