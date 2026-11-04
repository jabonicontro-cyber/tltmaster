-- Rollback for 20261120007100_shift_offer_audience.sql (one read-only function; no data is touched).
begin;
drop function if exists public.my_shift_offer_audiences();
commit;
