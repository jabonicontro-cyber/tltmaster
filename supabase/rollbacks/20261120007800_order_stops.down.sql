-- Rollback of 20261120007800_order_stops.sql (MK2 slice 1). Removes order stops, their save function and the
-- driver's read function. Stops recorded on orders are lost; orders, loads and tickets are untouched.
drop function if exists public.driver_load_stops();
drop function if exists public.save_order_stops(uuid, jsonb);
drop table if exists public.order_stops;
