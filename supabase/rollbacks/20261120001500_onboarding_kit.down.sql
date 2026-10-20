-- Rollback of 20261120001500_onboarding_kit.sql. DESTRUCTIVE for onboarding-kit data (questionnaires, worksheets,
-- checklists, sign-offs and their history): export them first if they matter. Restores the go-live functions of
-- 20261118000300 (activation no longer waits for the go-live acceptance). Run with psql -v ON_ERROR_STOP=1 -1 -f.

create or replace function private.lifecycle_activate_due()
 returns integer
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  r record;
  n integer := 0;
begin
  for r in
    select l.company_id, c.name from private.company_lifecycle l join public.companies c on c.id = l.company_id
    where l.stage = 'onboarding' and l.go_live_on is not null and l.onboarding_fee_status in ('paid', 'waived')
      and l.go_live_on <= private.company_today(l.company_id)
    for update of l skip locked
  loop
    update private.company_lifecycle
       set stage = 'live', live_at = now(), commitment_start = case when terms = 'annual' then go_live_on end, updated_at = now()
     where company_id = r.company_id and stage = 'onboarding';
    if found then
      n := n + 1;
      insert into private.platform_audit (actor_id, action, target_type, target_id, summary, detail)
      values (null, 'company_went_live', 'company', r.company_id::text, 'Went live on the scheduled day', jsonb_build_object('company_name', r.name, 'scheduled', true));
    end if;
  end loop;
  return n;
end;
$$;
revoke all on function private.lifecycle_activate_due() from public, anon, authenticated;

create or replace function public.platform_lifecycle_go_live_now(p_company uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  v private.company_lifecycle;
  v_admin uuid;
  v_signed timestamptz;
begin
  v_admin := private.require_platform_admin();
  v := private.lifecycle_for_update(p_company);
  if v.stage = 'live' then
    return private.lifecycle_json(p_company) || jsonb_build_object('already_live', true);
  end if;
  if v.stage <> 'onboarding' then
    raise exception 'A company goes live from onboarding, after the onboarding fee is received or waived.' using errcode = 'P0001';
  end if;
  select u.last_sign_in_at into v_signed from auth.users u where u.id = v_admin;
  if v_signed is null or v_signed < now() - interval '5 minutes' then
    raise exception 'Enter your password again to go live now.' using errcode = '42501';
  end if;
  update private.company_lifecycle
     set stage = 'live', live_at = now(), go_live_on = private.company_today(p_company),
         commitment_start = case when terms = 'annual' then private.company_today(p_company) end, updated_by = v_admin, updated_at = now()
   where company_id = p_company;
  perform private.platform_log('company_went_live', 'company', p_company::text, 'Went live now (password confirmed)',
                               jsonb_build_object('company_id', p_company, 'scheduled', false, 'previous_go_live_on', v.go_live_on));
  return private.lifecycle_json(p_company);
end;
$$;
revoke all on function public.platform_lifecycle_go_live_now(uuid) from public, anon;
grant execute on function public.platform_lifecycle_go_live_now(uuid) to authenticated;

drop function if exists public.platform_onboarding_go_live_sign(uuid, text, text, integer);
drop function if exists public.platform_onboarding_form_save(uuid, text, jsonb, integer);
drop function if exists public.platform_onboarding_kit(uuid);
drop function if exists public.onboarding_go_live_sign(text, text, integer);
drop function if exists public.onboarding_form_save(text, jsonb, integer);
drop function if exists public.onboarding_kit();
drop function if exists private.onboarding_signoff(uuid, text, text, text, integer, text);
drop function if exists private.onboarding_form_save(uuid, text, jsonb, integer, boolean);
drop function if exists private.onboarding_kit_json(uuid);
drop function if exists private.go_live_gated(uuid);
drop function if exists private.go_live_accepted(uuid);
drop function if exists private.go_live_blockers(uuid);
drop function if exists private.go_live_items();
drop table if exists public.onboarding_signoffs;
drop table if exists public.onboarding_form_versions;
drop table if exists public.onboarding_forms;
drop function if exists private.onboarding_kit_append_only();
