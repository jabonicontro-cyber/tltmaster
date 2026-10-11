-- Reverses supabase/migrations/20261029000100_shared_early_access_password.sql.
-- NOT a migration: run by hand, only after a backup and only if the founder asks.
-- Devices admitted with the shared password lose early access (their grants are
-- revoked, not deleted); per-recipient site codes keep working. The password's
-- records stay as revoked site codes (their hash matches no code), and the
-- "shared_rotated" audit entries become "code_revoked" with a note.
begin;

update private.site_access_grants g set revoked_at = now(), revoke_reason = 'Shared password removed'
from private.early_access_codes c
where g.code_id = c.id and c.purpose = 'site_shared' and g.revoked_at is null;
update private.early_access_codes set revoked_at = now(), revoke_reason = 'Shared password removed'
where purpose = 'site_shared' and revoked_at is null;
update private.early_access_codes set purpose = 'site_access' where purpose = 'site_shared';
update private.early_access_audit set action = 'code_revoked', detail = detail || '{"rollback": "shared_rotated"}'
where action = 'shared_rotated';

drop function if exists public.site_access_enter_shared(text, text, integer, integer);
drop function if exists public.site_access_revoke_grant(uuid, text);

alter table private.early_access_codes drop constraint early_access_codes_purpose_check;
alter table private.early_access_codes add constraint early_access_codes_purpose_check
  check (purpose in ('company_signup', 'site_access'));
alter table private.early_access_audit drop constraint early_access_audit_action_check;
alter table private.early_access_audit add constraint early_access_audit_action_check
  check (action in ('code_created', 'code_revoked', 'grants_revoked', 'grant_revoked'));

-- The earlier listing, exactly as in 20261023000100_site_access_gate.sql.
drop function public.early_access_list_codes();
create function public.early_access_list_codes()
returns table (id uuid, purpose text, label text, max_uses integer, used integer, active_grants integer,
               expires_at timestamptz, revoked_at timestamptz, revoke_reason text, created_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select c.id, c.purpose, c.label, c.max_uses,
         case when c.purpose = 'site_access'
              then (select count(*)::int from private.site_access_grants g where g.code_id = c.id)
              else (select count(*)::int from private.early_access_redemptions r where r.code_id = c.id) end,
         (select count(*)::int from private.site_access_grants g
           where g.code_id = c.id and g.revoked_at is null and g.expires_at > now()),
         c.expires_at, c.revoked_at, c.revoke_reason, c.created_at
  from private.early_access_codes c
  order by c.created_at desc
$$;
revoke execute on function public.early_access_list_codes() from public, anon, authenticated;
grant execute on function public.early_access_list_codes() to service_role;

commit;
