-- =============================================================================
-- Route Planner fix: the yard could never be saved.
--
-- company_settings is updated through column-level grants (see 20261027000200), and 20261112000500 added
-- yard_latitude / yard_longitude without one, so every save of the yard (Settings, Route Planner and the demo
-- samples) failed with "permission denied". Row access is unchanged: RLS still requires settings.manage.
--
-- Reversible: supabase/rollbacks/20261120002700_yard_location_grant.down.sql
-- =============================================================================

grant update (yard_latitude, yard_longitude) on public.company_settings to authenticated;
