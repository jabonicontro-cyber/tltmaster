-- Rollback of 20261120022300_platform_owner_invite.sql (not a migration; run by hand after a backup). Removes inviting a
-- company's first owner from the console and the invitations table (open invitation links stop working). Owners who
-- already accepted keep their membership; the platform audit and company history keep their records.
begin;

drop function if exists public.owner_invite_accept(text);
drop function if exists public.owner_invite_peek(text);
drop function if exists public.platform_owner_invites(uuid);
drop function if exists public.platform_owner_invite_withdraw(uuid);
drop function if exists public.platform_owner_invite(uuid, text, text);
drop function if exists private.owner_invite_blocked(uuid);
drop function if exists private.company_has_owner(uuid);
drop table if exists private.owner_invitations;

commit;
