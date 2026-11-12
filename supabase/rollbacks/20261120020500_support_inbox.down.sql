-- Rollback of 20261120020500_support_inbox.sql (not a migration; run by hand after a backup). Removes the support inbox functions, the notes and replies staff
-- recorded (back up first) and who handled each request. Request statuses set from the inbox stay as they are.
begin;

drop function if exists public.platform_my_support_work();
drop function if exists public.platform_support_request_update(uuid, text, text, text);
drop function if exists public.platform_support_request(uuid);
drop function if exists public.platform_support_inbox(text);
drop table if exists private.help_support_notes;
revoke select, insert on public.help_support_requests from authenticated;
grant select, insert on public.help_support_requests to authenticated;
alter table public.help_support_requests drop column if exists handled_by;
alter table public.help_support_requests drop column if exists updated_at;

commit;
