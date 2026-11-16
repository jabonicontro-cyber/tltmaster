-- Rollback of 20261120022100_truck_day_start_times.sql (not a migration; run by hand with a backup first).
-- Removes the "different start times" function. Slots already added stay as they are (ordinary loads); the board then
-- adds trucks with one shared start time again.
drop function if exists public.truck_day_slots(uuid, date, time[], time, text);
