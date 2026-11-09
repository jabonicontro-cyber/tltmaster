-- Rollback of 20261120011000_driver_stop_undo: the driver's Undo is removed. Taps already undone stay as they are
-- (an empty time, recorded again by the next tap); the history entries stay.
begin;
drop function if exists public.load_stop_undo(uuid, text, text);
commit;
