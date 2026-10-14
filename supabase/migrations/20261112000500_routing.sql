-- =============================================================================
-- Route planner, first slice (owner 2026-10-14: HERE as the first truck-routing provider).
--
-- * company_settings.yard_latitude / yard_longitude — where the company's trucks
--   start and end the day. Both set or both empty. Written like every other
--   company setting (settings.manage, existing RLS policy).
-- * customer_sites.location_source / located_at — where a site's coordinates
--   came from: '' (none), 'manual' (typed by a person) or 'here' (found by the
--   routing provider's geocoder). Coordinates found by a geocoder are an
--   estimate of the address and are labelled as such in the app.
--
-- No routes, distances or provider responses are stored. Reversible:
-- supabase/rollbacks/20261112000500_routing.down.sql
-- =============================================================================

alter table public.company_settings
  add column yard_latitude numeric(9, 6) check (yard_latitude between -90 and 90),
  add column yard_longitude numeric(9, 6) check (yard_longitude between -180 and 180),
  add constraint company_settings_yard_pair check ((yard_latitude is null) = (yard_longitude is null));

alter table public.customer_sites
  add column location_source text not null default '' check (location_source in ('', 'manual', 'here')),
  add column located_at timestamptz,
  -- NOT VALID: existing rows are not re-checked (a half-filled pair from before stays readable; new writes are checked).
  add constraint customer_sites_location_pair check ((latitude is null) = (longitude is null)) not valid;

-- Coordinates entered before this update have no recorded source; call them manual.
update public.customer_sites set location_source = 'manual', located_at = updated_at where latitude is not null and location_source = '';
