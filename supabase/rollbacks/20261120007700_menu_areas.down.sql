-- Rollback of 20261120007700_menu_areas.sql: every company shows every area again.
alter table public.company_settings drop column if exists hidden_areas;
