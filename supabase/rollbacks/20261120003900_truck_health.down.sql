-- Rollback for 20261120003900_truck_health.sql: the company's truck health rules (defaults return if re-applied).
revoke update (truck_health_rules) on public.company_settings from authenticated;
alter table public.company_settings drop column if exists truck_health_rules;
