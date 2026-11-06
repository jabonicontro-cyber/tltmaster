-- Adding a person who already has a Taviron sign-in needs their consent (security review 2026-11-06, M1; owner decision
-- 2026-11-06 "They must accept"). Before, add_existing_member attached any existing account to the caller's company at
-- once, after which its owner could read the person's email, phone and current company. Now:
--   * add_existing_member records an invitation (public.membership_invitations) instead of a membership. Nothing about the
--     person is revealed to the company until they accept; the company sees "Invited, waiting to accept".
--   * The person sees their invitations (my_membership_invitations) and accepts or declines; accepting creates the
--     membership with the invited role and links the person record the company made for that email, if any.
--   * add_company_member (used right after a brand-new sign-in is created by the invitation email) now accepts only a
--     sign-in made in the last hour that belongs to no company, so it cannot attach an existing account by its id.
--   * The company can withdraw a waiting invitation.
-- Reversible: supabase/rollbacks/20261120009100_membership_invitations.down.sql.

create table public.membership_invitations (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies (id) on delete cascade,
  user_id     uuid not null references auth.users (id) on delete cascade,
  role        public.app_role not null,
  full_name   text not null default '' check (length(full_name) <= 120),
  email       text not null default '' check (length(email) <= 254),
  invited_by  uuid references auth.users (id) on delete set null,
  status      text not null default 'pending' check (status in ('pending', 'accepted', 'declined', 'withdrawn')),
  created_at  timestamptz not null default now(),
  decided_at  timestamptz
);
create unique index membership_invitations_pending on public.membership_invitations (company_id, user_id) where status = 'pending';
create index membership_invitations_user on public.membership_invitations (user_id) where status = 'pending';
-- Row-level security with no policy: read through the functions below only.
alter table public.membership_invitations enable row level security;
create trigger a_company_guard before update of company_id on public.membership_invitations
  for each row execute function private.forbid_company_change();
create trigger z_no_support_visit before insert or update or delete on public.membership_invitations
  for each row execute function private.forbid_during_support_visit();

create or replace function public.add_existing_member(p_email text, p_role public.app_role, p_full_name text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_company uuid;
  v_user    uuid;
  v_m       public.company_memberships%rowtype;
begin
  perform private.require_permission('users.manage');
  v_company := private.require_company();
  if p_role = 'owner' and private.current_app_role() is distinct from 'owner' then
    raise exception 'Only an owner can add another owner.' using errcode = '42501';
  end if;
  select id into v_user from public.profiles where lower(email) = lower(trim(p_email));
  if v_user is null then return jsonb_build_object('found', false); end if;

  select * into v_m from public.company_memberships where company_id = v_company and user_id = v_user;
  if found then
    if not v_m.active then
      raise exception 'This person was deactivated in your company. Reactivate them in the list below.';
    end if;
    return jsonb_build_object('found', true, 'already', true);
  end if;
  -- An invitation the person accepts; a second invite refreshes the waiting one.
  insert into public.membership_invitations (company_id, user_id, role, full_name, email, invited_by)
  values (v_company, v_user, p_role, left(trim(coalesce(p_full_name, '')), 120), left(lower(trim(p_email)), 254), auth.uid())
  on conflict (company_id, user_id) where status = 'pending'
  do update set role = excluded.role, full_name = excluded.full_name, invited_by = excluded.invited_by, created_at = now();
  perform private.log_event('member.invited', 'company', v_company, format('Invited %s as %s (waiting to accept)', lower(trim(p_email)), p_role),
    jsonb_build_object('role', p_role));
  return jsonb_build_object('found', true, 'already', false, 'invited', true);
end;
$$;

create or replace function public.add_company_member(p_user_id uuid, p_role public.app_role, p_full_name text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_company uuid;
begin
  perform private.require_permission('users.manage');
  v_company := private.require_company();
  if p_role = 'owner' and private.current_app_role() is distinct from 'owner' then
    raise exception 'Only an owner can add another owner.' using errcode = '42501';
  end if;
  -- Only a sign-in in no other company that this company made: provisioned here (username sign-ins), or created by
  -- the invitation email in the last hour (M1). Already in this company: "already a member" (a retry).
  if exists (select 1 from public.company_memberships m where m.user_id = p_user_id and m.company_id <> v_company)
     or not (exists (select 1 from private.account_provisions a where a.company_id = v_company and a.user_id = p_user_id)
             or exists (select 1 from auth.users u where u.id = p_user_id and u.created_at > now() - interval '1 hour')
             or exists (select 1 from public.company_memberships m where m.user_id = p_user_id and m.company_id = v_company)) then
    raise exception 'User not found.';
  end if;

  insert into public.company_memberships (company_id, user_id, role, active)
  values (v_company, p_user_id, p_role, true);

  update public.profiles
     set full_name = trim(p_full_name)
   where id = p_user_id
     and length(trim(coalesce(p_full_name, ''))) between 1 and 120;
exception
  when unique_violation then
    raise exception 'This user is already a member of your company.';
end;
$$;

-- The signed-in person's waiting invitations.
create or replace function public.my_membership_invitations()
returns table (id uuid, company_name text, role public.app_role, invited_by text, created_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select i.id, c.name, i.role, coalesce(nullif(p.full_name, ''), 'Someone at the company'), i.created_at
  from public.membership_invitations i
  join public.companies c on c.id = i.company_id and c.active
  left join public.profiles p on p.id = i.invited_by
  where i.user_id = auth.uid() and i.status = 'pending'
  order by i.created_at desc
$$;
revoke all on function public.my_membership_invitations() from public, anon;
grant execute on function public.my_membership_invitations() to authenticated;

create or replace function public.answer_membership_invitation(p_invitation uuid, p_accept boolean)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v public.membership_invitations;
  v_email text;
begin
  if auth.uid() is null then raise exception 'Sign in first.' using errcode = '42501'; end if;
  select * into v from public.membership_invitations where id = p_invitation and user_id = auth.uid() and status = 'pending' for update;
  if v.id is null then raise exception 'This invitation is no longer open.' using errcode = 'P0002'; end if;
  update public.membership_invitations set status = case when p_accept then 'accepted' else 'declined' end, decided_at = now() where id = v.id;
  if not p_accept then return null; end if;
  insert into public.company_memberships (company_id, user_id, role, active) values (v.company_id, auth.uid(), v.role, true)
  on conflict (company_id, user_id) do nothing;
  -- The person record the company made for this email, if any, is now theirs.
  select lower(u.email) into v_email from auth.users u where u.id = auth.uid();
  update public.employees e set user_id = auth.uid()
   where e.id = (select x.id from public.employees x
                 where x.company_id = v.company_id and x.user_id is null and lower(x.work_email) = v_email
                 order by x.created_at limit 1);
  insert into public.audit_events (company_id, actor_id, action, entity_type, entity_id, summary, details)
  values (v.company_id, auth.uid(), 'member.joined', 'user', auth.uid(), format('Accepted the invitation as %s', v.role), jsonb_build_object('role', v.role));
  return v.company_id;
end;
$$;
revoke all on function public.answer_membership_invitation(uuid, boolean) from public, anon;
grant execute on function public.answer_membership_invitation(uuid, boolean) to authenticated;

-- For the company (users.manage): who was invited and is still waiting, and withdrawing.
create or replace function public.company_membership_invitations()
returns table (id uuid, email text, full_name text, role public.app_role, created_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_company uuid := private.require_company();
begin
  perform private.require_permission('users.manage');
  return query
    select i.id, i.email, i.full_name, i.role, i.created_at
    from public.membership_invitations i
    where i.company_id = v_company and i.status = 'pending'
    order by i.created_at desc;
end;
$$;
revoke all on function public.company_membership_invitations() from public, anon;
grant execute on function public.company_membership_invitations() to authenticated;

create or replace function public.withdraw_membership_invitation(p_invitation uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_company uuid := private.require_company();
begin
  perform private.require_permission('users.manage');
  update public.membership_invitations set status = 'withdrawn', decided_at = now()
   where id = p_invitation and company_id = v_company and status = 'pending';
  if not found then raise exception 'This invitation is no longer open.' using errcode = 'P0002'; end if;
end;
$$;
revoke all on function public.withdraw_membership_invitation(uuid) from public, anon;
grant execute on function public.withdraw_membership_invitation(uuid) to authenticated;
