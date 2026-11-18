-- Rollback of 20261120024500_data_export.sql (not a migration; run by hand after a backup). Removes the data download
-- functions; Settings → Download your data then says the database update is not installed. Audit entries already
-- written ("data_exported") stay in the audit log. No other rows change.
begin;

drop function if exists public.data_export_files(integer, integer);
drop function if exists public.data_export_rows(text, uuid);
drop function if exists public.data_export_summary();
drop function if exists public.data_export_record(text);
drop function if exists private.data_export_company();
drop function if exists private.data_export_tables();

commit;
