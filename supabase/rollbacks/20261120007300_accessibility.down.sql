-- Rollback for 20261120007300_accessibility.sql (people's accessibility settings are removed with the table).
begin;
drop function if exists public.set_my_accessibility(jsonb);
drop table if exists public.user_accessibility;
commit;
