-- Invite a company's first owner from the platform console (PC2, owner decision 2026-11-14: "Yes, Admin only").
--   * Only an Admin of the Taviron team (never Support) who has just entered their password and authenticator code
--     again (private.require_fresh_reauth), from the company page.
--   * Only for a real customer company that is open (not archived, not canceled) and has no active owner yet. Demo
--     companies are refused: prospect demos get their owner through scripts/platform-admin.mjs demo-owner, and a demo
--     never sends anything. An email that belongs to the Taviron team is refused (and refused again on accepting): staff
--     enter companies only as support visits with the owner's grant, never as members.
--   * The invitation is a single-use link: only the SHA-256 hash of its token is stored, it expires after 7 days, a new
--     invitation for the same company withdraws the open one, and it can be withdrawn. The person opens the link,
--     chooses their own password (or signs in with the Taviron sign-in they already have for that email), sets up an
--     authenticator app and accepts; the database checks the email, the verified authenticator (aal2) and that the
--     company still has no owner, then makes them its owner.
--   * Every invitation, withdrawal and acceptance is in the platform audit (private.platform_log) and in the company's
--     own history (public.audit_events).
-- No email is sent by the database: the console's server action emails the link through the configured provider or
-- shows it to the Admin to hand over. Reversible: supabase/rollbacks/20261120022300_platform_owner_invite.down.sql.

create table private.owner_invitations (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies (id) on delete cascade,
  email       text not null check (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' and length(email) <= 254),
  full_name   text not null default '' check (length(full_name) <= 120),
  token_hash  text not null unique,
  invited_by  uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  accepted_at timestamptz,
  accepted_by uuid references auth.users (id) on delete set null,
  revoked_at  timestamptz,
  revoked_by  uuid references auth.users (id) on delete set null
);
create unique index owner_invitations_open on private.owner_invitations (company_id) where accepted_at is null and revoked_at is null;
create index owner_invitations_company on private.owner_invitations (company_id, created_at desc);
alter table private.owner_invitations enable row level security;

create or replace function private.company_has_owner(p_company uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.company_memberships m where m.company_id = p_company and m.active and m.role = 'owner')
$$;
revoke all on function private.company_has_owner(uuid) from public, anon, authenticated;

-- Why a company cannot get an owner invitation now, or null when it can.
create or replace function private.owner_invite_blocked(p_company uuid)
returns text language sql stable security definer set search_path = '' as $$
  select case
    when c.id is null then 'Company not found.'
    when c.is_demo then 'Demo companies do not get owner invitations from here: a demo never sends anything. Prospect demos get their owner through Demo management.'
    when c.archived_at is not null or not c.active then 'This company is archived. Restore it first.'
    when l.stage = 'canceled' then 'This company''s subscription is canceled.'
    when private.company_has_owner(c.id) then 'This company already has an owner. The owner adds everyone else from People.'
  end
  from (select 1) x
  left join public.companies c on c.id = p_company
  left join private.company_lifecycle l on l.company_id = c.id
$$;
revoke all on function private.owner_invite_blocked(uuid) from public, anon, authenticated;

create or replace function public.platform_owner_invite(p_company uuid, p_email text, p_full_name text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_admin   uuid;
  v_email   text := lower(trim(coalesce(p_email, '')));
  v_name    text := trim(coalesce(p_full_name, ''));
  v_blocked text;
  v_company text;
  v_token   text;
  v_id      uuid;
  v_exp     timestamptz := now() + interval '7 days';
begin
  v_admin := private.require_platform_admin();
  perform private.require_fresh_reauth();
  perform 1 from public.companies where id = p_company for update;
  v_blocked := private.owner_invite_blocked(p_company);
  if v_blocked is not null then
    raise exception '%', v_blocked using errcode = case when v_blocked = 'Company not found.' then 'P0002' else 'P0001' end;
  end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or length(v_email) > 254 then raise exception 'Enter a valid email address.' using errcode = '22023'; end if;
  if length(v_name) < 2 or length(v_name) > 120 then raise exception 'Enter the owner''s name.' using errcode = '22023'; end if;
  if exists (select 1 from private.platform_admins a join auth.users u on u.id = a.user_id where lower(u.email) = v_email and a.revoked_at is null) then
    raise exception 'That email belongs to the Taviron team. A customer''s owner needs their own email; the team helps through support visits.' using errcode = 'P0001';
  end if;
  select name into v_company from public.companies where id = p_company;
  update private.owner_invitations set revoked_at = now(), revoked_by = v_admin
   where company_id = p_company and accepted_at is null and revoked_at is null;
  v_token := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  insert into private.owner_invitations (company_id, email, full_name, token_hash, invited_by, expires_at)
  values (p_company, v_email, v_name, private.staff_token_hash(v_token), v_admin, v_exp)
  returning id into v_id;
  perform private.platform_log('owner_invited', 'company', p_company::text,
    format('Invited %s (%s) as the first owner', v_name, v_email),
    jsonb_build_object('company_id', p_company, 'email', v_email, 'invite', v_id, 'expires_at', v_exp));
  insert into public.audit_events (company_id, actor_id, action, entity_type, entity_id, summary, details)
  values (p_company, v_admin, 'member.invited', 'company', p_company,
          format('The Taviron team invited %s (%s) to be the company''s owner (waiting to accept)', v_name, v_email),
          jsonb_build_object('role', 'owner', 'by', 'taviron', 'invite', v_id));
  return jsonb_build_object('id', v_id, 'token', v_token, 'expires_at', v_exp, 'email', v_email, 'full_name', v_name, 'company_name', v_company);
end;
$$;
revoke all on function public.platform_owner_invite(uuid, text, text) from public, anon;
grant execute on function public.platform_owner_invite(uuid, text, text) to authenticated;

create or replace function public.platform_owner_invite_withdraw(p_invite uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_admin uuid;
  v private.owner_invitations;
begin
  v_admin := private.require_platform_admin();
  update private.owner_invitations set revoked_at = now(), revoked_by = v_admin
   where id = p_invite and accepted_at is null and revoked_at is null
  returning * into v;
  if v.id is null then raise exception 'That invitation is no longer open.' using errcode = 'P0002'; end if;
  perform private.platform_log('owner_invite_withdrawn', 'company', v.company_id::text, format('Withdrew the owner invitation for %s', v.email),
    jsonb_build_object('company_id', v.company_id, 'email', v.email, 'invite', v.id));
  insert into public.audit_events (company_id, actor_id, action, entity_type, entity_id, summary, details)
  values (v.company_id, v_admin, 'member.invite_withdrawn', 'company', v.company_id,
          format('The Taviron team withdrew the owner invitation for %s', v.email), jsonb_build_object('role', 'owner', 'by', 'taviron', 'invite', v.id));
end;
$$;
revoke all on function public.platform_owner_invite_withdraw(uuid) from public, anon;
grant execute on function public.platform_owner_invite_withdraw(uuid) to authenticated;

-- The company page: whether an owner can be invited now, and the invitations (open, and settled in the last 90 days).
create or replace function public.platform_owner_invites(p_company uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_platform_admin();
  if not exists (select 1 from public.companies where id = p_company) then raise exception 'Company not found.' using errcode = 'P0002'; end if;
  return jsonb_build_object(
    'blocked', private.owner_invite_blocked(p_company),
    'has_owner', private.company_has_owner(p_company),
    'invites', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', i.id, 'email', i.email, 'full_name', i.full_name, 'created_at', i.created_at, 'expires_at', i.expires_at,
        'status', case when i.accepted_at is not null then 'accepted' when i.revoked_at is not null then 'withdrawn'
                       when i.expires_at <= now() then 'expired' else 'open' end,
        'invited_by', coalesce(private.person_name(i.invited_by), 'Operator')) order by i.open desc, i.created_at desc), '[]'::jsonb)
      from (select x.*, (x.accepted_at is null and x.revoked_at is null) as open from private.owner_invitations x
            where x.company_id = p_company and ((x.accepted_at is null and x.revoked_at is null) or x.created_at > now() - interval '90 days')
            order by (x.accepted_at is null and x.revoked_at is null) desc, x.created_at desc limit 20) i));
end;
$$;
revoke all on function public.platform_owner_invites(uuid) from public, anon;
grant execute on function public.platform_owner_invites(uuid) to authenticated;

-- What the invitation page shows to whoever holds the link (the token is the secret).
create or replace function public.owner_invite_peek(p_token text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select jsonb_build_object(
       'status', case when i.accepted_at is not null then 'used' when i.revoked_at is not null then 'withdrawn'
                      when i.expires_at <= now() then 'expired'
                      when private.owner_invite_blocked(i.company_id) is not null then 'closed' else 'open' end,
       'email', i.email, 'full_name', i.full_name, 'company_name', c.name, 'expires_at', i.expires_at,
       'has_account', exists (select 1 from auth.users u where lower(u.email) = i.email))
     from private.owner_invitations i join public.companies c on c.id = i.company_id
     where i.token_hash = private.staff_token_hash(p_token)),
    jsonb_build_object('status', 'invalid'))
$$;
revoke all on function public.owner_invite_peek(text) from public;
grant execute on function public.owner_invite_peek(text) to anon, authenticated;

-- Accept: signed in as the invited email, with an authenticator app verified in this session; the company still has
-- no owner. Returns the company id (now the person's current company).
create or replace function public.owner_invite_accept(p_token text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v private.owner_invitations;
  v_email   text;
  v_blocked text;
  v_emp     uuid;
begin
  if auth.uid() is null then raise exception 'Sign in first.' using errcode = '42501'; end if;
  select * into v from private.owner_invitations where token_hash = private.staff_token_hash(p_token) for update;
  if v.id is null or v.accepted_at is not null or v.revoked_at is not null or v.expires_at <= now() then
    raise exception 'This invitation is no longer valid. Ask Taviron for a new one.' using errcode = 'P0002';
  end if;
  select lower(u.email) into v_email from auth.users u where u.id = auth.uid();
  if v_email is distinct from v.email then
    raise exception 'This invitation is for %. Sign in with that email.', v.email using errcode = '42501';
  end if;
  if not exists (select 1 from auth.mfa_factors f where f.user_id = auth.uid() and f.status = 'verified' and f.factor_type = 'totp') or not private.aal2() then
    raise exception 'Set up an authenticator app and enter its code first.' using errcode = '42501';
  end if;
  if exists (select 1 from private.platform_admins a where a.user_id = auth.uid() and a.revoked_at is null) then
    raise exception 'A Taviron team sign-in cannot be a customer''s owner. Ask Taviron to invite a different email.' using errcode = '42501';
  end if;
  perform 1 from public.companies where id = v.company_id for update;
  v_blocked := private.owner_invite_blocked(v.company_id);
  if v_blocked is not null then
    raise exception 'This invitation can no longer be used: %', v_blocked using errcode = 'P0001';
  end if;

  insert into public.company_memberships (company_id, user_id, role, active) values (v.company_id, auth.uid(), 'owner', true)
  on conflict (company_id, user_id) do update set role = 'owner', active = true;
  update private.owner_invitations set accepted_at = now(), accepted_by = auth.uid() where id = v.id;
  update public.profiles set full_name = v.full_name where id = auth.uid() and coalesce(full_name, '') = '' and v.full_name <> '';
  update public.profiles set active_company_id = v.company_id where id = auth.uid();
  -- Every sign-in is a person: the record the company made for this email, if any, else a new one.
  select x.id into v_emp from public.employees x where x.company_id = v.company_id and x.user_id = auth.uid() limit 1;
  if v_emp is null then
    update public.employees e set user_id = auth.uid()
     where e.id = (select x.id from public.employees x
                   where x.company_id = v.company_id and x.user_id is null and lower(x.work_email) = v_email
                   order by x.created_at limit 1)
    returning e.id into v_emp;
  end if;
  if v_emp is null then
    insert into public.employees (company_id, user_id, full_name, work_email, department, status)
    values (v.company_id, auth.uid(), coalesce(nullif(v.full_name, ''), split_part(v_email, '@', 1)), left(v_email, 200), 'management', 'active');
  end if;
  perform private.platform_log('owner_joined', 'company', v.company_id::text,
    format('%s accepted the invitation and is the owner', coalesce(nullif(v.full_name, ''), v.email)),
    jsonb_build_object('company_id', v.company_id, 'email', v.email, 'invite', v.id, 'invited_by', v.invited_by));
  insert into public.audit_events (company_id, actor_id, action, entity_type, entity_id, summary, details)
  values (v.company_id, auth.uid(), 'member.joined', 'user', auth.uid(), 'Accepted the invitation as owner', jsonb_build_object('role', 'owner', 'invite', v.id));
  return v.company_id;
end;
$$;
revoke all on function public.owner_invite_accept(text) from public, anon;
grant execute on function public.owner_invite_accept(text) to authenticated;
