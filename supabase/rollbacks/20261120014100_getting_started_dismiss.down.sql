-- Rollback of 20261120014100_getting_started_dismiss.sql (not a migration; run by hand with a backup first).
-- Removes the remembered "Getting started" dismissals (the app then falls back to the browser's own memory), the
-- function and the key.
begin;
drop function if exists public.dismiss_getting_started();
delete from public.user_preferences where key = 'getting_started';
alter table public.user_preferences drop constraint if exists user_preferences_key_check;
alter table public.user_preferences add constraint user_preferences_key_check check (key in ('command_center', 'demo_welcome'));
commit;
