-- Rollback of 20261120007600_industry.sql: every company goes back to the aggregate wording.
alter table public.company_settings drop column if exists industry;
