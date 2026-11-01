-- Rollback for 20261120004900_telematics.sql (B101 GPS and hours). Removes positions and hours recorded since.
begin;
drop function if exists public.demo_telematics_samples();
drop function if exists public.telematics_ingest(text, jsonb);
drop function if exists public.telematics_record_hours(uuid, text, integer, integer, integer);
drop function if exists public.telematics_record_position(uuid, double precision, double precision, timestamptz, text);
drop function if exists public.telematics_revoke_feed_key();
drop function if exists public.telematics_set_feed_key(text, text);
drop function if exists public.telematics_save_settings(text, integer);
drop function if exists public.telematics_status();
drop table if exists public.driver_hours;
drop table if exists public.vehicle_positions;
drop table if exists public.telematics_settings;
commit;
