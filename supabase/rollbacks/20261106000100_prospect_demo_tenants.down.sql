-- Reverses supabase/migrations/20261106000100_prospect_demo_tenants.sql.
-- NOT a migration: run by hand, only after a backup and only if the founder asks.
-- Prospect demo companies stay (still is_demo, so nothing is sent), but they
-- become ordinary demos again: the next "Start the demo" would deactivate them.
-- Deactivate or keep them deliberately before rolling back.
begin;
drop function if exists public.platform_prospect_demo_add_owner(uuid, uuid, text);
drop function if exists public.platform_prospect_demo_create(text, text, text, text);

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
  update public.company_memberships m set active = false
  from public.companies c where c.id = m.company_id and c.is_demo and c.active;
  update public.companies set active = false where is_demo and active;
  get diagnostics v_old = row_count;

  v_id := private.create_company('Northfield Aggregates (Demo)', 'demo-' || substr(md5(gen_random_uuid()::text), 1, 10));
  update public.companies set is_demo = true where id = v_id;
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
  select id into v_id from public.companies where is_demo and active order by created_at desc limit 1;
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
                     from public.companies c where c.is_demo and c.active order by c.created_at desc limit 1)
  );
end;
$$;

alter table public.companies drop constraint if exists companies_demo_kind;
alter table public.companies drop column if exists demo_kind;
commit;
