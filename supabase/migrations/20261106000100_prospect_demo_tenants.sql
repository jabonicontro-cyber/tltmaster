-- =============================================================================
-- Prospect demo tenants: standing, isolated demo companies for one prospect.
--
-- Before this migration every demo company was the presenter's rolling demo:
-- "Start the demo" (platform_demo_start) deactivated EVERY demo company and its
-- memberships, and "Enter the demo" joined the newest one. A demo tenant made
-- for a prospect would have been switched off by the next presenter demo, and
-- the presenter could have been sent into it.
--
-- * companies.demo_kind: 'presenter' (the rolling demo) or 'prospect' (a
--   standing demo tenant for one prospect); NULL for real companies. Every demo
--   keeps is_demo = true, so the demo bar shows and nothing is ever sent
--   (invitations and emails are refused in demo companies).
-- * platform_demo_start / platform_demo_enter / platform_overview only touch
--   presenter demos.
-- * platform_prospect_demo_create(name, city, state, timezone): platform admin
--   only. Creates the prospect demo and makes the caller its owner so the
--   server can fill it with fictional data through the normal app functions.
-- * platform_prospect_demo_add_owner(company, user): SERVICE ROLE ONLY (run by
--   scripts/platform-admin.mjs demo-owner after the owner approves it). Makes an
--   EXISTING login the owner of a PROSPECT demo — never of a real company or the
--   presenter demo. It creates no login and no password; the person sets their
--   own password through a one-time setup link.
--
-- Rollback: supabase/rollbacks/20261106000100_prospect_demo_tenants.down.sql
-- =============================================================================

alter table public.companies add column demo_kind text check (demo_kind in ('presenter', 'prospect'));
update public.companies set demo_kind = 'presenter' where is_demo;
alter table public.companies add constraint companies_demo_kind check ((demo_kind is not null) = is_demo);

create or replace function public.platform_demo_start(p_timezone text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me  uuid := private.require_platform_admin();
  v_id  uuid;
  v_old integer;
  v_tz  text := coalesce(nullif(trim(p_timezone), ''), 'America/Chicago');
begin
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = v_tz) then
    raise exception 'Unknown time zone.' using errcode = '22023';
  end if;
  -- Only the presenter's rolling demo is replaced; prospect demo tenants are never touched.
  update public.company_memberships m set active = false
  from public.companies c where c.id = m.company_id and c.demo_kind = 'presenter' and c.active;
  update public.companies set active = false where demo_kind = 'presenter' and active;
  get diagnostics v_old = row_count;

  v_id := private.create_company('Northfield Aggregates (Demo)', 'demo-' || substr(md5(gen_random_uuid()::text), 1, 10));
  update public.companies set is_demo = true, demo_kind = 'presenter' where id = v_id;
  update public.company_settings set timezone = v_tz, city = '', state = '' where company_id = v_id;
  insert into public.company_memberships (company_id, user_id, role, active) values (v_id, v_me, 'owner', true);
  update public.profiles set active_company_id = v_id where id = v_me;
  perform private.platform_log('demo_started', 'company', v_id::text, 'Started a fresh demo company',
                               jsonb_build_object('previous_demos_deactivated', v_old));
  return v_id;
end;
$$;

create or replace function public.platform_demo_enter()
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.require_platform_admin();
  v_id uuid;
begin
  select id into v_id from public.companies where demo_kind = 'presenter' and active order by created_at desc limit 1;
  if v_id is null then
    raise exception 'There is no demo company yet. Start one first.' using errcode = 'P0002';
  end if;
  insert into public.company_memberships (company_id, user_id, role, active) values (v_id, v_me, 'owner', true)
  on conflict do nothing;
  update public.company_memberships set active = true, role = 'owner' where company_id = v_id and user_id = v_me;
  update public.profiles set active_company_id = v_id where id = v_me;
  perform private.platform_log('demo_entered', 'company', v_id::text, 'Opened the demo company');
  return v_id;
end;
$$;

create or replace function public.platform_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_platform_admin();
  return jsonb_build_object(
    'new_leads', (select count(*) from private.leads where status = 'new' and disposition <> 'spam'),
    'due_follow_ups', (select count(*) from private.leads where follow_up_on <= current_date and status not in ('converted', 'not_proceeding')),
    'open_leads', (select count(*) from private.leads where status not in ('converted', 'not_proceeding')),
    'companies', (select count(*) from public.companies where active and not is_demo),
    'imports_in_review', (select count(*) from private.import_batches where status = 'review'),
    'demo_company', (select jsonb_build_object('id', c.id, 'name', c.name, 'created_at', c.created_at)
                     from public.companies c where c.demo_kind = 'presenter' and c.active order by c.created_at desc limit 1)
  );
end;
$$;

/** Create a standing prospect demo tenant; the caller (platform admin) becomes its owner to seed it. */
create or replace function public.platform_prospect_demo_create(p_name text, p_city text, p_state text, p_timezone text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me   uuid := private.require_platform_admin();
  v_name text := private.clean_text(p_name, 120, 'Company name');
  v_tz   text := coalesce(nullif(trim(p_timezone), ''), 'America/Chicago');
  v_id   uuid;
begin
  if length(v_name) < 2 then raise exception 'Name the demo company.' using errcode = 'P0001'; end if;
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = v_tz) then
    raise exception 'Unknown time zone.' using errcode = '22023';
  end if;
  if exists (select 1 from public.companies where demo_kind = 'prospect' and active and lower(name) = lower(v_name)) then
    raise exception 'A prospect demo with this name already exists.' using errcode = 'P0001';
  end if;
  v_id := private.create_company(v_name, 'prospect-' || substr(md5(gen_random_uuid()::text), 1, 10));
  update public.companies set is_demo = true, demo_kind = 'prospect' where id = v_id;
  update public.company_settings set timezone = v_tz, city = left(coalesce(trim(p_city), ''), 80),
    state = upper(left(coalesce(trim(p_state), ''), 2)) where company_id = v_id;
  insert into public.company_memberships (company_id, user_id, role, active) values (v_id, v_me, 'owner', true);
  update public.profiles set active_company_id = v_id where id = v_me;
  perform private.platform_log('prospect_demo_created', 'company', v_id::text, 'Created a prospect demo company', jsonb_build_object('name', v_name));
  return v_id;
end;
$$;

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

revoke execute on function public.platform_prospect_demo_create(text, text, text, text) from public, anon;
grant execute on function public.platform_prospect_demo_create(text, text, text, text) to authenticated;
revoke execute on function public.platform_prospect_demo_add_owner(uuid, uuid) from public, anon, authenticated;
grant execute on function public.platform_prospect_demo_add_owner(uuid, uuid) to service_role;
