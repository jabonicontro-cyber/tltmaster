-- Rollback of 20261120022000_ai_company_optin.sql (not a migration; run by hand with a backup first).
-- Removes each company's Ask Taviron choice and the recorded first-use notices, the two functions and the key. Ask
-- Taviron then stays Blocked everywhere ("needs a database update") until the migration is applied again.
begin;
drop function if exists public.set_ai_assistant_allowed(boolean);
drop function if exists public.acknowledge_ai_notice(integer);
delete from public.user_preferences where key = 'ai_notice';
alter table public.user_preferences drop constraint if exists user_preferences_key_check;
alter table public.user_preferences add constraint user_preferences_key_check
  check (key in ('command_center', 'demo_welcome', 'getting_started'));
alter table public.company_settings
  drop column if exists ai_assistant_allowed,
  drop column if exists ai_assistant_changed_at,
  drop column if exists ai_assistant_changed_by;
commit;
