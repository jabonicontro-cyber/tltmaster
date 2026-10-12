-- =============================================================================
-- Follow-ups to 20261105000100 (Communications) and 20261106000100 (prospect demos),
-- which are already applied on the hosted database and therefore not edited.
--
-- 1. comm_directory also returns each person's photo state: photo_updated_at (their
--    own profile photo) and avatar_key (the illustrated avatar on their employee
--    record), so Communications shows the same picture as the employee directory.
-- 2. platform_prospect_demo_add_owner gains an optional full name: it sets the
--    login's name when it has none and links the demo's matching, still unlinked
--    employee record (scripts/platform-admin.mjs demo-owner --name "...").
-- 3. platform_prospect_demo_retire(company): platform admin only, prospect demos
--    only. Deactivates the company and its memberships (nothing is deleted), so a
--    fresh demo with the same name can be created.
--
-- Rollback: supabase/rollbacks/20261107000100_people_photos_and_demo_retire.down.sql
-- =============================================================================

create or replace function public.comm_directory()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
begin
  perform private.require_permission('comms.message');
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'user_id', m.user_id, 'name', private.comm_user_name(m.user_id), 'role', m.role,
      'department', (select e.department from public.employees e where e.company_id = v_company and e.user_id = m.user_id limit 1),
      -- Their own profile photo wins; otherwise the illustrated avatar chosen on their employee record.
      'photo_updated_at', (select p.photo_updated_at from public.profiles p where p.id = m.user_id),
      'avatar_key', coalesce((select e.avatar_key from public.employees e where e.company_id = v_company and e.user_id = m.user_id limit 1), ''),
      'presence', private.comm_presence(v_company, m.user_id),
      'work_status', private.comm_work_status(v_company, m.user_id)) order by private.comm_user_name(m.user_id))
    from public.company_memberships m
    where m.company_id = v_company and m.active and m.role is not null
  ), '[]'::jsonb);
end;
$$;

drop function if exists public.platform_prospect_demo_add_owner(uuid, uuid);

/**
 * Make an existing login the owner of a prospect demo tenant. Service role only
 * (scripts/platform-admin.mjs demo-owner). Refuses real companies and the
 * presenter demo, never creates a login, and never grants platform access.
 */
create or replace function public.platform_prospect_demo_add_owner(p_company uuid, p_user uuid, p_full_name text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.companies where id = p_company and demo_kind = 'prospect' and active) then
    raise exception 'Owners can be added this way only to an active prospect demo company.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.profiles where id = p_user) then
    raise exception 'That login does not exist yet. Create it with a setup link first.' using errcode = 'P0002';
  end if;
  insert into public.company_memberships (company_id, user_id, role, active) values (p_company, p_user, 'owner', true)
  on conflict (company_id, user_id) do update set role = 'owner', active = true;
  -- Their first sign-in lands in the demo only if they belong to no other company.
  update public.profiles set active_company_id = p_company
  where id = p_user and (active_company_id is null
    or not exists (select 1 from public.company_memberships m where m.user_id = p_user and m.company_id = active_company_id and m.active));
  -- Their name (only when the login has none yet), and the demo's matching, still unlinked employee record.
  if nullif(trim(p_full_name), '') is not null then
    update public.profiles set full_name = left(trim(p_full_name), 120) where id = p_user and coalesce(trim(full_name), '') = '';
    update public.employees set user_id = p_user
    where company_id = p_company and user_id is null and lower(full_name) = lower(trim(p_full_name))
      and not exists (select 1 from public.employees e where e.company_id = p_company and e.user_id = p_user);
  end if;
  insert into public.audit_events (company_id, actor_id, action, entity_type, entity_id, summary, details)
  values (p_company, null, 'membership.demo_owner_added', 'company', p_company, 'Prospect demo owner added by the platform operator',
          jsonb_build_object('user_id', p_user));
end;
$$;

/** Retire a prospect demo (platform admin): it and its memberships become inactive; nothing is deleted. */
create or replace function public.platform_prospect_demo_retire(p_company uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.require_platform_admin();
  v_name text;
begin
  select name into v_name from public.companies where id = p_company and demo_kind = 'prospect' and active;
  if not found then raise exception 'Only an active prospect demo company can be retired.' using errcode = 'P0002'; end if;
  update public.company_memberships set active = false where company_id = p_company;
  update public.companies set active = false where id = p_company;
  update public.profiles set active_company_id = null where active_company_id = p_company;
  perform private.platform_log('prospect_demo_retired', 'company', p_company::text, 'Retired a prospect demo company', jsonb_build_object('name', v_name));
end;
$$;

revoke execute on function public.platform_prospect_demo_add_owner(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.platform_prospect_demo_add_owner(uuid, uuid, text) to service_role;
revoke execute on function public.platform_prospect_demo_retire(uuid) from public, anon;
grant execute on function public.platform_prospect_demo_retire(uuid) to authenticated;
