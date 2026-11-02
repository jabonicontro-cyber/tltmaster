-- Rollback for 20261120005800_fuel_ifta.sql. Forgets fuel purchases and trip sheets (the audit log keeps its entries).
begin;
drop function if exists public.demo_fuel_samples();
drop function if exists public.fuel_my_trucks(date);
drop function if exists public.fuel_void(text, uuid, text);
drop function if exists public.fuel_record_trip_sheet(jsonb);
drop function if exists public.fuel_record_purchase(jsonb);
drop function if exists private.fuel_writer(uuid, uuid, date);
drop table if exists public.trip_sheets;
drop table if exists public.fuel_purchases;
commit;
