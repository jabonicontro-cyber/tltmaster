-- Rollback for 20261120004100_site_info_from_customers.sql. Directions already applied to sites stay (they are the
-- site's own directions now); submissions and site photo records are removed. Files in the site-photos bucket are not
-- deleted here (Supabase forbids deleting storage rows in SQL): remove them through the Storage API if wanted.
drop function if exists public.demo_site_note();
drop function if exists public.driver_site_photos();
drop function if exists public.site_photo_path(uuid);
drop function if exists public.site_info_review(uuid, boolean, text, text);
drop function if exists public.portal_site_photo_begin(text, uuid, text, integer);
drop function if exists public.portal_site_info_submit(text, uuid, text, text, text, text, text);
drop function if exists public.portal_sites(text);
drop table if exists public.site_photos;
drop table if exists public.site_info_submissions;
