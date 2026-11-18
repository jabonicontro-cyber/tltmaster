-- =============================================================================
-- "New company" rules that hold on every database (CI fix 2026-11-18).
--
-- Two rules apply to new companies only (owner decisions):
--   * the Starter default (20261120022200 / 20261120023000, 2026-11-14): a new company whose first plan is Starter
--     starts with the optional modules off;
--   * the starting preset (20261120023000, 2026-11-16, MOD1): a Taviron Admin may pick a preset only while a company is
--     being set up, or for a demo. Top Line and every existing customer are never changed from the console.
-- Both told "existing" from "new" by the company's creation date alone (on or after 2026-11-14 / 2026-11-16). That holds
-- on the hosted databases, where Top Line was created in October 2026, but not on a database built from the migrations
-- (CI, a fresh db-reset): there Top Line is created by 20261011000200 on the day the database is built, so it read as a
-- "new" company and a Taviron Admin could pick a preset for it.
--
-- private.established_companies records every company that exists when this migration runs (Top Line and every
-- existing customer on the hosted databases; Top Line on a database built from the migrations). Such a company is
-- never "new": the Starter default never changes it, and the console never sets its modules (its owner chooses in
-- Settings), whatever its creation date or lifecycle stage. The creation dates stay as a second condition. Companies
-- created after this migration are not recorded, so the rules apply to them exactly as decided. Nothing else reads the
-- table; no data in a company changes.
--
-- Additive (a new private table; two functions replaced with one more condition each). Works with the code before and
-- after it (no signature changes). Rollback: supabase/rollbacks/20261120024640_established_companies.down.sql.
-- =============================================================================

create table if not exists private.established_companies (
  company_id  uuid primary key references public.companies (id) on delete cascade,
  recorded_at timestamptz not null default now()
);
comment on table private.established_companies is
  'Companies that existed when the new-company rules were installed (20261120024640): never treated as new companies.';
alter table private.established_companies enable row level security;
revoke all on table private.established_companies from public, anon, authenticated;

insert into private.established_companies (company_id)
select c.id from public.companies c
on conflict (company_id) do nothing;

-- A Taviron Admin may pick a starting preset for a demo (any age), or for a company that is new (not established, so
-- never Top Line or an existing customer) and not live yet: in setup (a lifecycle record that is not live or canceled)
-- or, without a lifecycle record, created on or after the decision (2026-11-16).
create or replace function private.modules_preset_allowed(p_company uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.companies c where c.id = p_company and c.is_demo)
      or (not exists (select 1 from private.established_companies e where e.company_id = p_company)
          and (exists (select 1 from private.company_lifecycle l
                        where l.company_id = p_company and l.stage <> 'live' and l.live_at is null and l.canceled_at is null)
               or (not exists (select 1 from private.company_lifecycle l where l.company_id = p_company)
                   and exists (select 1 from public.companies c where c.id = p_company and c.created_at >= timestamptz '2026-11-16 00:00:00+00'))))
$$;
revoke all on function private.modules_preset_allowed(uuid) from public, anon, authenticated;

-- Starter default (owner decision 2026-11-14), as in 20261120023000, and never for an established company.
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
  if exists (select 1 from private.established_companies e where e.company_id = new.company_id) then
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

do $$
declare
  f text;
begin
  foreach f in array array['modules_preset_allowed', 'starter_default_hidden_areas'] loop
    if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                   where n.nspname = 'private' and p.proname = f and p.prosecdef and 'search_path=""' = any (p.proconfig)) then
      raise exception 'private.% is not installed as expected', f;
    end if;
  end loop;
  if not exists (select 1 from private.established_companies e where e.company_id = '00000000-0000-4000-8000-000000000001')
     and exists (select 1 from public.companies c where c.id = '00000000-0000-4000-8000-000000000001') then
    raise exception 'Top Line is not recorded as an established company';
  end if;
end;
$$;
