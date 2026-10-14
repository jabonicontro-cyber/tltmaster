-- Rollback of 20261112000500_routing.sql (not a migration; run by hand with a backup first).
-- Removes the yard location and the site location source. Site coordinates themselves stay (they predate it).
begin;
alter table public.customer_sites drop constraint if exists customer_sites_location_pair;
alter table public.customer_sites drop column if exists located_at;
alter table public.customer_sites drop column if exists location_source;
alter table public.company_settings drop constraint if exists company_settings_yard_pair;
alter table public.company_settings drop column if exists yard_longitude;
alter table public.company_settings drop column if exists yard_latitude;
commit;
