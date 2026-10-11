-- Reverses supabase/migrations/20261030000100_profile_self_service.sql.
-- NOT a migration: run by hand, only after a backup and only if the founder asks.
-- Display names, phone numbers and profile photos entered by people are deleted.
begin;
drop function if exists public.profile_photo(uuid);
drop function if exists public.set_my_photo(text, text);
drop function if exists public.update_my_profile(text, text);
drop function if exists public.my_profile();
drop table if exists private.profile_photos;
alter table public.profiles drop column if exists photo_updated_at, drop column if exists phone, drop column if exists display_name;
commit;
