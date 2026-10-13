-- Rollback of 20261109000100_demo_welcome.sql (not a migration; run by hand with a backup first).
-- Removes the remembered demo welcomes (the app then falls back to its browser cookie), the function and the key.
begin;
drop function if exists public.dismiss_demo_welcome();
delete from public.user_preferences where key = 'demo_welcome';
alter table public.user_preferences drop constraint if exists user_preferences_key_check;
alter table public.user_preferences add constraint user_preferences_key_check check (key in ('command_center'));
commit;
