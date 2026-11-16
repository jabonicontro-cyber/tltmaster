-- Rollback of 20261120023000_workflow_modules.sql (not a migration; run by hand with a backup first).
-- Every company then has every workflow on again, as before MOD1. The SF1 menu (hidden_areas) keeps what each company
-- last chose for its nine areas (the migration kept it in step), so the previous app shows the same menu. The record
-- of changes stays in the audit log. Tickets entered without dispatch and won quotes are not touched here; roll back
-- 20261120023200 and 20261120023100 first.
drop trigger if exists z_modules_log on public.company_settings;
drop trigger if exists b_modules_check on public.company_settings;
drop function if exists public.platform_company_modules(uuid);
drop function if exists public.platform_set_company_modules(uuid, text);
drop function if exists public.set_company_modules(text[]);
drop function if exists private.modules_preset_allowed(uuid);
drop function if exists private.modules_log();
drop function if exists private.modules_check();
alter table public.company_settings drop constraint if exists company_settings_modules_off_known;
alter table public.company_settings drop column if exists modules_off;
drop function if exists private.module_on(uuid, text);
drop function if exists private.module_label(text);
drop function if exists private.module_preset(text);
drop function if exists private.area_of_module(text);
drop function if exists private.module_of_area(text);
drop function if exists private.module_keys();

-- The Starter default as in 20261120022200 (writes the menu).
create or replace function private.starter_default_hidden_areas()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_areas constant text[] := array['/quotes', '/support', '/customer-portal', '/order-to-cash', '/payroll', '/schedule', '/time-off', '/reports'];
begin
  if new.plan_version_id is null or (tg_op = 'UPDATE' and old.plan_version_id is not null) then
    return new;
  end if;
  if new.stage = 'live' or new.live_at is not null then
    return new;
  end if;
  if not exists (select 1 from private.platform_plan_versions v where v.id = new.plan_version_id and v.plan_key = 'starter') then
    return new;
  end if;
  if not exists (select 1 from public.companies c where c.id = new.company_id and not c.is_demo and c.created_at >= timestamptz '2026-11-14 00:00:00+00') then
    return new;
  end if;
  update public.company_settings
     set hidden_areas = v_areas
   where company_id = new.company_id and hidden_areas = '{}';
  if found then
    perform private.platform_log('starter_menu_defaults', 'company', new.company_id::text,
                                 'Starter plan: the menu starts with the essentials (owners can turn areas back on)',
                                 jsonb_build_object('hidden_areas', v_areas));
  end if;
  return new;
end;
$$;
revoke all on function private.starter_default_hidden_areas() from public, anon, authenticated;
