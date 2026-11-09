-- Rollback of 20261120011100_field_report_photos: photos on driver reports removed. The bucket and any stored files
-- are left in place (remove them by hand in Storage if wanted); the records go with the table.
begin;
drop function if exists public.field_report_photo_path(uuid);
drop function if exists public.field_report_photo_begin(uuid, text, integer);
drop table if exists public.field_report_photos;
commit;
