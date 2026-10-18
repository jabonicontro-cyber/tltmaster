-- Rollback of 20261118000100_platform_launchpad.sql: removes the Launchpad, company detail and demo-refresh audit
-- functions, and restores platform_create_company as defined in 20261028000100 (without the duplicate checks).
-- Audit rows already written (demo_refreshed / demo_refresh_failed) stay: the platform audit is append-only.
drop function if exists public.platform_launchpad();
drop function if exists public.platform_company(uuid);
drop function if exists public.platform_company_directory();
drop function if exists public.platform_record_demo_refresh(uuid, boolean, text);
drop function if exists private.setup_missing(jsonb);
drop function if exists private.company_setup(uuid);

create or replace function public.platform_create_company(p_name text, p_timezone text, p_lead uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me   uuid := private.require_platform_admin();
  v_name text := trim(coalesce(p_name, ''));
  v_tz   text := coalesce(nullif(trim(p_timezone), ''), 'America/Chicago');
  v_base text;
  v_slug text;
  v_id   uuid;
  v_lead private.leads%rowtype;
begin
  if length(v_name) < 2 or length(v_name) > 120 then
    raise exception 'Enter the company name (2 to 120 characters).' using errcode = '22023';
  end if;
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = v_tz) then
    raise exception 'Unknown time zone.' using errcode = '22023';
  end if;
  v_base := trim(both '-' from left(regexp_replace(lower(v_name), '[^a-z0-9]+', '-', 'g'), 40));
  loop
    v_slug := coalesce(nullif(v_base, ''), 'company') || '-' || substr(md5(gen_random_uuid()::text), 1, 6);
    exit when not exists (select 1 from public.companies where slug = v_slug);
  end loop;
  v_id := private.create_company(v_name, v_slug);
  update public.company_settings set timezone = v_tz where company_id = v_id;
  if p_lead is not null then
    select * into v_lead from private.leads where id = p_lead for update;
    if found then
      if v_lead.status <> 'converted' then
        insert into private.lead_events (lead_id, actor_id, action, detail)
        values (p_lead, v_me, 'status_changed', jsonb_build_object('from', v_lead.status, 'to', 'converted'));
      end if;
      if v_lead.onboarding_stage = '' then
        insert into private.lead_events (lead_id, actor_id, action, detail)
        values (p_lead, v_me, 'onboarding_changed', jsonb_build_object('from', '', 'to', 'in_progress'));
      end if;
      update private.leads set status = 'converted', disposition = '',
             onboarding_stage = case when onboarding_stage = '' then 'in_progress' else onboarding_stage end,
             updated_at = now()
      where id = p_lead;
      insert into private.lead_events (lead_id, actor_id, action, detail)
      values (p_lead, v_me, 'company_created', jsonb_build_object('company_id', v_id, 'company_name', v_name));
    end if;
  end if;
  perform private.platform_log('company_created', 'company', v_id::text, 'Created company ' || v_name,
                               jsonb_build_object('timezone', v_tz, 'lead_id', p_lead));
  return v_id;
end;
$$;
