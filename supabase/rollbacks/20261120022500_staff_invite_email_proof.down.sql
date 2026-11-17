-- Rollback of 20261120022500_staff_invite_email_proof.sql (not a migration; run by hand after a backup): the Taviron
-- team invitation page and acceptance as they were in 20261120008900. Roll back only together with the app code from
-- before the security review of 2026-11-16 (that code creates a confirmed sign-in for a handed-over link again).
begin;

drop function if exists public.platform_staff_invite_mark_emailed(uuid);

-- What the join page shows to whoever holds the link (the token is the secret).
create or replace function public.staff_invite_peek(p_token text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select jsonb_build_object(
       'status', case when i.accepted_at is not null then 'used' when i.revoked_at is not null then 'withdrawn'
                      when i.expires_at <= now() then 'expired' else 'open' end,
       'email', i.email, 'full_name', i.full_name, 'level', i.level, 'expires_at', i.expires_at,
       'has_account', exists (select 1 from auth.users u where lower(u.email) = i.email))
     from private.platform_staff_invites i where i.token_hash = private.staff_token_hash(p_token)),
    jsonb_build_object('status', 'invalid'))
$$;
revoke all on function public.staff_invite_peek(text) from public;
grant execute on function public.staff_invite_peek(text) to anon, authenticated;

-- Accept: signed in as the invited email, with an authenticator app verified in this session.
create or replace function public.platform_staff_accept(p_token text)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v private.platform_staff_invites;
  v_email text;
begin
  if auth.uid() is null then raise exception 'Sign in first.' using errcode = '42501'; end if;
  select * into v from private.platform_staff_invites where token_hash = private.staff_token_hash(p_token) for update;
  if v.id is null or v.accepted_at is not null or v.revoked_at is not null or v.expires_at <= now() then
    raise exception 'This invitation is no longer valid. Ask for a new one.' using errcode = 'P0002';
  end if;
  select lower(u.email) into v_email from auth.users u where u.id = auth.uid();
  if v_email is distinct from v.email then
    raise exception 'This invitation is for %. Sign in with that email.', v.email using errcode = '42501';
  end if;
  if not exists (select 1 from auth.mfa_factors f where f.user_id = auth.uid() and f.status = 'verified' and f.factor_type = 'totp') or not private.aal2() then
    raise exception 'Set up an authenticator app and enter its code first.' using errcode = '42501';
  end if;
  insert into private.platform_admins (user_id, note, level)
  values (auth.uid(), format('Invited %s', to_char(v.created_at, 'YYYY-MM-DD')), v.level)
  on conflict (user_id) do update set revoked_at = null, revoke_note = '', level = excluded.level, note = excluded.note, granted_at = now();
  update private.platform_staff_invites set accepted_at = now(), accepted_by = auth.uid() where id = v.id;
  update public.profiles set full_name = v.full_name where id = auth.uid() and coalesce(full_name, '') = '' and v.full_name <> '';
  perform private.platform_log('staff_joined', 'user', auth.uid()::text,
    format('%s joined the team as %s', coalesce(nullif(v.full_name, ''), v.email), case v.level when 'admin' then 'Admin' else 'Support' end),
    jsonb_build_object('email', v.email, 'level', v.level, 'invite', v.id, 'invited_by', v.invited_by));
  return v.level;
end;
$$;
revoke all on function public.platform_staff_accept(text) from public, anon;
grant execute on function public.platform_staff_accept(text) to authenticated;

alter table private.platform_staff_invites drop column if exists link_emailed_at;

commit;
