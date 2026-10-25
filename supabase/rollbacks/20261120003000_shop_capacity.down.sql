-- Rollback of 20261120003000_shop_capacity.sql (not a migration; run by hand with a backup first).
-- DESTRUCTIVE for data entered since: shop settings, mechanic skills and work order estimates are removed.
begin;
drop function if exists public.maintenance_capacity(date, integer);
drop function if exists public.maintenance_set_estimate(uuid, numeric);
drop function if exists public.maintenance_set_skills(uuid, text[]);
drop function if exists public.maintenance_save_shop(integer, time, time, integer[]);
alter table public.work_orders drop column if exists estimated_hours;
drop table if exists public.mechanic_skills;
drop table if exists public.maintenance_shop_settings;
commit;
