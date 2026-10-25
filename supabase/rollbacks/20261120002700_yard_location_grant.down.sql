-- Rollback of 20261120002700_yard_location_grant.sql (not a migration; run by hand if ever needed).
revoke update (yard_latitude, yard_longitude) on public.company_settings from authenticated;
