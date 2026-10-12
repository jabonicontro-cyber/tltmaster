-- Reverses supabase/migrations/20261107000100_people_photos_and_demo_retire.sql.
-- NOT a migration: run by hand, only after a backup and only if the founder asks.
-- Retired prospect demos stay retired (reactivate them by hand if needed).
begin;
drop function if exists public.profile_photo_versions(uuid[]);
drop function if exists public.platform_prospect_demo_retire(uuid);
drop function if exists public.platform_prospect_demo_add_owner(uuid, uuid, text);

/**
 * Make an existing login the owner of a prospect demo tenant. Service role only
 * (scripts/platform-admin.mjs demo-owner). Refuses real companies and the
 * presenter demo, never creates a login, and never grants platform access.
 */
create or replace function public.platform_prospect_demo_add_owner(p_company uuid, p_user uuid)
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
  insert into public.audit_events (company_id, actor_id, action, entity_type, entity_id, summary, details)
  values (p_company, null, 'membership.demo_owner_added', 'company', p_company, 'Prospect demo owner added by the platform operator',
          jsonb_build_object('user_id', p_user));
end;
$$;

revoke execute on function public.platform_prospect_demo_add_owner(uuid, uuid) from public, anon, authenticated;
grant execute on function public.platform_prospect_demo_add_owner(uuid, uuid) to service_role;

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
      'presence', private.comm_presence(v_company, m.user_id),
      'work_status', private.comm_work_status(v_company, m.user_id)) order by private.comm_user_name(m.user_id))
    from public.company_memberships m
    where m.company_id = v_company and m.active and m.role is not null
  ), '[]'::jsonb);
end;
$$;
commit;
