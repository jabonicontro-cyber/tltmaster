-- Rollback of 20261120010000_driver_people: drivers no longer get a People record automatically.
-- Removes the two triggers and their three functions. The People records the migration created (backfill) and those the
-- triggers created since stay: they are ordinary records that time off, schedules and pay may already reference, and
-- a person can mark any of them inactive in People. Nothing else changes.

drop trigger if exists driver_person_insert on public.drivers;
drop trigger if exists driver_person_update on public.drivers;
drop function if exists private.driver_person_insert();
drop function if exists private.driver_person_update();
drop function if exists private.driver_person_add(uuid);
