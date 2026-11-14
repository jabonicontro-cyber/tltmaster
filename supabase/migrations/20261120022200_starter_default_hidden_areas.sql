-- =============================================================================
-- Simple mode for new Starter companies (owner decision 2026-11-14, master plan SF1).
--
-- A company gets its plan in the platform console (public.platform_lifecycle_terms writes
-- private.company_lifecycle.plan_version_id); no creation path chooses one. So "a new company on the Starter plan" is a
-- company whose FIRST plan is Starter, and only when all of these hold:
--   * the company was created on or after 2026-11-14 (the decision; every older company, Top Line included, is
--     never changed);
--   * it is not a demo company (demos have no lifecycle and keep their documented menus);
--   * it has not gone live, and its menu is still the default (nothing hidden), so an owner's own choice is never
--     overwritten.
-- Then its menu starts with these areas hidden: Quotes, Support, Customer Portal, Order to Cash, Payroll, Schedule,
-- Time Off and Reports. Maintenance stays visible (safety core). Menu only, as for every hidden area: pages, permissions
-- and rules are unchanged, and an owner turns any area back on in Settings → Company → Areas in the menu.
-- A later plan change never changes the menu. The change is logged to platform activity and, through the existing
-- company_settings audit trigger, to the company's audit log.
--
-- Additive. Rollback: supabase/rollbacks/20261120022200_starter_default_hidden_areas.down.sql.
-- =============================================================================

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

drop trigger if exists z_starter_default_hidden_areas on private.company_lifecycle;
create trigger z_starter_default_hidden_areas
  after insert or update of plan_version_id on private.company_lifecycle
  for each row execute function private.starter_default_hidden_areas();

do $$
begin
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'private' and p.proname = 'starter_default_hidden_areas'
                   and p.prosecdef and 'search_path=""' = any (p.proconfig)) then
    raise exception 'starter_default_hidden_areas is not installed as expected';
  end if;
end;
$$;
