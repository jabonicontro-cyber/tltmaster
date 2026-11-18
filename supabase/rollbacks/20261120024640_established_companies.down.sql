-- Rollback of 20261120024640_established_companies.sql (not a migration; run by hand with a backup first).
-- Puts private.modules_preset_allowed and private.starter_default_hidden_areas back as in 20261120023000 (creation dates
-- only), then removes private.established_companies. No company data changes. Roll this back before 20261120023000.
begin;

create or replace function private.modules_preset_allowed(p_company uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.companies c where c.id = p_company and c.is_demo)
      or exists (select 1 from private.company_lifecycle l
                 where l.company_id = p_company and l.stage <> 'live' and l.live_at is null and l.canceled_at is null)
      or (not exists (select 1 from private.company_lifecycle l where l.company_id = p_company)
          and exists (select 1 from public.companies c where c.id = p_company and c.created_at >= timestamptz '2026-11-16 00:00:00+00'))
$$;
revoke all on function private.modules_preset_allowed(uuid) from public, anon, authenticated;

-- Starter default (owner decision 2026-11-14), now as modules. Same conditions as before.
create or replace function private.starter_default_hidden_areas()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_modules constant text[] := array['quotes', 'support', 'customer_portal', 'order_to_cash', 'payroll', 'schedule', 'time_off', 'reports'];
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
     set modules_off = v_modules
   where company_id = new.company_id and modules_off = '{}' and hidden_areas = '{}';
  if found then
    perform private.platform_log('starter_menu_defaults', 'company', new.company_id::text,
                                 'Starter plan: the company starts with the essentials (owners can switch areas back on)',
                                 jsonb_build_object('modules_off', v_modules));
  end if;
  return new;
end;
$$;
revoke all on function private.starter_default_hidden_areas() from public, anon, authenticated;

drop table if exists private.established_companies;
commit;
