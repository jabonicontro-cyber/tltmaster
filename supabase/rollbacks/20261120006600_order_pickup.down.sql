-- Rollback of 20261120006600_order_pickup.
drop function if exists public.driver_load_pickups();
drop function if exists public.set_order_pickup(uuid, uuid);
drop index if exists public.orders_pickup_location_idx;
alter table public.orders drop constraint if exists orders_pickup_location_fkey;
alter table public.orders drop column if exists pickup_location_id;
