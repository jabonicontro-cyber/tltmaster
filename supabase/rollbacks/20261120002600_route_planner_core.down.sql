-- Rollback of 20261120002600_route_planner_core.sql (not a migration; run by hand with a backup first).
-- DESTRUCTIVE for data entered since: saved routes, saved locations and truck routing dimensions are removed.
begin;
drop table if exists public.saved_route_stops;
drop table if exists public.saved_routes;
drop table if exists public.company_locations;
alter table public.trucks
  drop column if exists height_cm,
  drop column if exists width_cm,
  drop column if exists length_cm,
  drop column if exists gross_weight_kg,
  drop column if exists axle_count;
commit;
