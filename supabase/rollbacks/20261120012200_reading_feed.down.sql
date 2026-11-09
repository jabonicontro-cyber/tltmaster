-- Rollback of 20261120012200_reading_feed: readings are recorded only on the Preventive page again. Removes the four
-- triggers, the two functions and the source columns. Readings already recorded from inspections, trip sheets, fuel
-- entries and work orders stay (they are real readings, never lower than the one before them); audit entries stay.
drop trigger if exists vehicle_inspections_reading on public.vehicle_inspections;
drop trigger if exists trip_sheets_reading on public.trip_sheets;
drop trigger if exists fuel_purchases_reading on public.fuel_purchases;
drop trigger if exists work_orders_reading on public.work_orders;
drop function if exists private.reading_from_record();
drop function if exists private.feed_truck_reading(uuid, uuid, numeric, numeric, text, uuid);
alter table public.truck_readings drop column if exists source_id;
alter table public.truck_readings drop column if exists source;
