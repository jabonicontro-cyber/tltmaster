-- Rollback for 20261120009100_membership_invitations.sql: existing sign-ins are again added directly (as before
-- 2026-11-06); waiting invitations are dropped.
CREATE OR REPLACE FUNCTION public.add_existing_member(p_email text, p_role app_role, p_full_name text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
    return jsonb_build_object('found', true, 'already', true, 'user_id', v_user, 'role', v_m.role);
  end if;
  insert into public.company_memberships (company_id, user_id, role, active) values (v_company, v_user, p_role, true);
  -- A profile is shared: name it only if it has no other company.
  update public.profiles set full_name = trim(p_full_name)
  where id = v_user and length(trim(coalesce(p_full_name, ''))) between 1 and 120
    and not exists (select 1 from public.company_memberships m where m.user_id = v_user and m.company_id <> v_company);
  perform private.log_event('member.added', 'user', v_user, format('Existing account added as %s', p_role),
    jsonb_build_object('role', p_role));
  return jsonb_build_object('found', true, 'already', false, 'user_id', v_user, 'role', p_role);
end;
$function$

;

CREATE OR REPLACE FUNCTION public.add_company_member(p_user_id uuid, p_role app_role, p_full_name text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_company uuid;
begin
  perform private.require_permission('users.manage');
  v_company := private.require_company();
  if p_role = 'owner' and private.current_app_role() is distinct from 'owner' then
    raise exception 'Only an owner can add another owner.' using errcode = '42501';
  end if;

  if not exists (select 1 from public.profiles where id = p_user_id) then
    raise exception 'User not found.';
  end if;

  insert into public.company_memberships (company_id, user_id, role, active)
  values (v_company, p_user_id, p_role, true);

  update public.profiles
     set full_name = trim(p_full_name)
   where id = p_user_id
     and length(trim(coalesce(p_full_name, ''))) between 1 and 120
     and not exists (select 1 from public.company_memberships m
                     where m.user_id = p_user_id and m.company_id <> v_company);
exception
  when unique_violation then
    raise exception 'This user is already a member of your company.';
end;
$function$

;

drop function if exists public.withdraw_membership_invitation(uuid);
drop function if exists public.company_membership_invitations();
drop function if exists public.answer_membership_invitation(uuid, boolean);
drop function if exists public.my_membership_invitations();
drop table if exists public.membership_invitations;
