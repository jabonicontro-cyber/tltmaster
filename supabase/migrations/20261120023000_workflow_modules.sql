-- =============================================================================
-- Workflow modules (owner decisions 2026-11-16, master plan MOD1; design: docs/MODULES.md).
--
-- A company switches its main workflows on or off. company_settings.modules_off holds the modules switched OFF
-- (empty = everything on, so every existing company is unchanged). Switching off hides; it never deletes or changes a
-- record, a permission or a rule. Safety, Driver Reports and Communications are not modules, so they can never be off.
--
-- SF1 (menu-only hiding, 20261120007700) is migrated into modules: its nine areas are nine of the modules, copied from
-- hidden_areas. hidden_areas is kept and mirrored both ways, so the app before and after this migration both work.
-- The Starter default (20261120022200, owner decision 2026-11-14) now writes modules_off.
--
-- Who:  the company owner (settings.manage) through public.set_company_modules; a Taviron Admin through
--       public.platform_set_company_modules (a preset, only before go-live or for a demo). Every change is written to
--       the company audit log (trigger) and, for the Admin, to platform activity.
-- Additive. Rollback: supabase/rollbacks/20261120023000_workflow_modules.down.sql
-- =============================================================================

-- Module keys (mirrored in src/lib/modules.ts; tests/unit/modules.test.ts and tests/db/workflow-modules.test.ts check).
create or replace function private.module_keys()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array['quotes', 'orders', 'dispatch', 'tickets', 'billing', 'order_to_cash', 'payroll', 'maintenance',
               'customer_portal', 'support', 'schedule', 'time_off', 'reports']::text[]
$$;

-- SF1 menu areas ↔ modules (the same nine areas).
create or replace function private.module_of_area(p_area text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_area
    when '/quotes' then 'quotes' when '/support' then 'support' when '/customer-portal' then 'customer_portal'
    when '/maintenance' then 'maintenance' when '/order-to-cash' then 'order_to_cash' when '/payroll' then 'payroll'
    when '/schedule' then 'schedule' when '/time-off' then 'time_off' when '/reports' then 'reports' end
$$;

create or replace function private.area_of_module(p_module text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_module
    when 'quotes' then '/quotes' when 'support' then '/support' when 'customer_portal' then '/customer-portal'
    when 'maintenance' then '/maintenance' when 'order_to_cash' then '/order-to-cash' when 'payroll' then '/payroll'
    when 'schedule' then '/schedule' when 'time_off' then '/time-off' when 'reports' then '/reports' end
$$;

-- What each preset switches off (docs/MODULES.md §2; src/lib/modules.ts PRESETS).
create or replace function private.module_preset(p_preset text)
returns text[]
language sql
immutable
set search_path = ''
as $$
  select case p_preset
    when 'full' then '{}'::text[]
    when 'tickets_to_billing' then array['quotes', 'dispatch', 'order_to_cash', 'payroll', 'customer_portal', 'support', 'schedule', 'time_off']
    when 'quotes_only' then array['orders', 'dispatch', 'tickets', 'billing', 'order_to_cash', 'payroll', 'customer_portal', 'support', 'schedule', 'time_off']
  end
$$;

-- Plain words for the record.
create or replace function private.module_label(p_module text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_module
    when 'quotes' then 'Quotes' when 'orders' then 'Orders and jobs' when 'dispatch' then 'Dispatch'
    when 'tickets' then 'Delivery tickets' when 'billing' then 'Billing' when 'order_to_cash' then 'Order to Cash'
    when 'payroll' then 'Payroll' when 'maintenance' then 'Maintenance' when 'customer_portal' then 'Customer Portal'
    when 'support' then 'Support' when 'schedule' then 'Schedule' when 'time_off' then 'Time Off'
    when 'reports' then 'Reports' else p_module end
$$;

alter table public.company_settings add column if not exists modules_off text[] not null default '{}';
alter table public.company_settings drop constraint if exists company_settings_modules_off_known;
alter table public.company_settings add constraint company_settings_modules_off_known
  check (modules_off <@ array['quotes', 'orders', 'dispatch', 'tickets', 'billing', 'order_to_cash', 'payroll', 'maintenance',
                              'customer_portal', 'support', 'schedule', 'time_off', 'reports']::text[]);
comment on column public.company_settings.modules_off is
  'Workflow modules switched off (MOD1, docs/MODULES.md). Hidden only: records, permissions and rules are unchanged.';

-- Whether a module is on for a company (no settings row: everything on).
create or replace function private.module_on(p_company uuid, p_module text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select not coalesce((select p_module = any (s.modules_off) from public.company_settings s where s.company_id = p_company), false)
$$;
revoke all on function private.module_on(uuid, text) from public, anon, authenticated;


-- Dependencies and the SF1 mirror. A dependency that would break is refused with plain words.
create or replace function private.modules_check()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_off text[];
  v_sf1 constant text[] := array['quotes', 'support', 'customer_portal', 'maintenance', 'order_to_cash', 'payroll', 'schedule', 'time_off', 'reports'];
begin
  if tg_op = 'UPDATE' and new.hidden_areas is distinct from old.hidden_areas and new.modules_off is not distinct from old.modules_off then
    -- The previous app saved the menu: carry it into the modules (its nine areas only).
    new.modules_off := array(
      select m from unnest(old.modules_off) m where not (m = any (v_sf1))
      union
      select private.module_of_area(a) from unnest(new.hidden_areas) a where private.module_of_area(a) is not null);
    v_off := array(select distinct m from unnest(coalesce(new.modules_off, '{}')) m order by m);
    new.modules_off := v_off;
  else
    v_off := array(select distinct m from unnest(coalesce(new.modules_off, '{}')) m order by m);
    new.modules_off := v_off;
    -- Keep the old menu column in step for the previous app version.
    new.hidden_areas := array(select private.area_of_module(m) from unnest(v_off) m where private.area_of_module(m) is not null order by 1);
  end if;

  if 'orders' = any (v_off) and not ('dispatch' = any (v_off)) then
    raise exception 'Dispatch needs Orders and jobs. Switch Dispatch off too, or keep Orders and jobs on.' using errcode = 'P0001';
  end if;
  if 'orders' = any (v_off) and not ('tickets' = any (v_off)) then
    raise exception 'Delivery tickets need Orders and jobs (each ticket belongs to a job). Switch Delivery tickets off too, or keep Orders and jobs on.' using errcode = 'P0001';
  end if;
  if 'tickets' = any (v_off) and not ('billing' = any (v_off)) then
    raise exception 'Billing needs Delivery tickets. Switch Billing off too, or keep Delivery tickets on.' using errcode = 'P0001';
  end if;
  if 'tickets' = any (v_off) and not ('payroll' = any (v_off)) then
    raise exception 'Payroll needs Delivery tickets (pay comes from tickets). Switch Payroll off too, or keep Delivery tickets on.' using errcode = 'P0001';
  end if;
  if ('orders' = any (v_off) or 'billing' = any (v_off)) and not ('order_to_cash' = any (v_off)) then
    raise exception 'Order to Cash needs Orders and jobs and Billing. Switch Order to Cash off too, or keep both on.' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists b_modules_check on public.company_settings;
create trigger b_modules_check before insert or update of modules_off, hidden_areas on public.company_settings
  for each row execute function private.modules_check();

-- Every change is recorded in the company's audit log, with who and the lists before and after.
create or replace function private.modules_log()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_on  text[] := array(select m from unnest(old.modules_off) m where not (m = any (new.modules_off)));
  v_off text[] := array(select m from unnest(new.modules_off) m where not (m = any (old.modules_off)));
  v_summary text;
begin
  if new.modules_off is not distinct from old.modules_off then
    return new;
  end if;
  v_summary := concat_ws('; ',
    case when cardinality(v_off) > 0 then 'switched off: ' || (select string_agg(private.module_label(m), ', ' order by m) from unnest(v_off) m) end,
    case when cardinality(v_on) > 0 then 'switched on: ' || (select string_agg(private.module_label(m), ', ' order by m) from unnest(v_on) m) end);
  insert into public.audit_events (company_id, actor_id, action, entity_type, entity_id, summary, details)
  values (new.company_id, auth.uid(), 'settings.modules_changed', 'company_settings', new.company_id,
          'What you use: ' || v_summary,
          jsonb_build_object('before', to_jsonb(old.modules_off), 'after', to_jsonb(new.modules_off),
                             'switched_off', to_jsonb(v_off), 'switched_on', to_jsonb(v_on)));
  return new;
end;
$$;
revoke all on function private.modules_log() from public, anon, authenticated;

drop trigger if exists z_modules_log on public.company_settings;
create trigger z_modules_log after update of modules_off, hidden_areas on public.company_settings
  for each row execute function private.modules_log();

-- SF1 data carried over (the trigger fills hidden_areas back, unchanged).
update public.company_settings
   set modules_off = array(select private.module_of_area(a) from unnest(hidden_areas) a where private.module_of_area(a) is not null)
 where hidden_areas <> '{}' and modules_off = '{}';

-- The owner: any time, own company, settings.manage (checked here and by the update policy).
create or replace function public.set_company_modules(p_off text[])
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid;
  v_off     text[];
  v_bad     text;
  v_after   text[];
begin
  perform private.require_permission('settings.manage');
  v_company := private.require_company();
  select string_agg(m, ', ') into v_bad from unnest(coalesce(p_off, '{}')) m where not (m = any (private.module_keys()));
  if v_bad is not null then
    raise exception 'Unknown module: %.', v_bad using errcode = '22023';
  end if;
  v_off := array(select distinct m from unnest(coalesce(p_off, '{}')) m order by m);
  update public.company_settings set modules_off = v_off where company_id = v_company
  returning modules_off into v_after;
  if not found then
    raise exception 'Company settings not found.' using errcode = 'P0002';
  end if;
  return jsonb_build_object('modules_off', to_jsonb(v_after));
end;
$$;
revoke all on function public.set_company_modules(text[]) from public, anon;
grant execute on function public.set_company_modules(text[]) to authenticated;

-- A Taviron Admin may pick a starting preset while the company is being set up (not live yet), or for a demo. Existing
-- companies without a lifecycle record (created before this decision, Top Line included) are never changed here.
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

create or replace function public.platform_set_company_modules(p_company uuid, p_preset text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_off   text[] := private.module_preset(p_preset);
  v_after text[];
begin
  perform private.require_platform_admin();
  if not exists (select 1 from public.companies where id = p_company) then
    raise exception 'Company not found.' using errcode = 'P0002';
  end if;
  if v_off is null then
    raise exception 'Choose a starting point: Full operations, Tickets to billing or Quotes only.' using errcode = '22023';
  end if;
  if not private.modules_preset_allowed(p_company) then
    raise exception 'This company is live: its owner chooses what it uses in Settings.' using errcode = '42501';
  end if;
  update public.company_settings set modules_off = v_off where company_id = p_company returning modules_off into v_after;
  if not found then
    raise exception 'Company settings not found.' using errcode = 'P0002';
  end if;
  perform private.platform_log('company.modules_preset', 'company', p_company::text,
    'Starting setup: ' || case p_preset when 'full' then 'Full operations' when 'tickets_to_billing' then 'Tickets to billing' else 'Quotes only' end,
    jsonb_build_object('preset', p_preset, 'modules_off', to_jsonb(v_after)));
  return jsonb_build_object('modules_off', to_jsonb(v_after));
end;
$$;
revoke all on function public.platform_set_company_modules(uuid, text) from public, anon;
grant execute on function public.platform_set_company_modules(uuid, text) to authenticated;

create or replace function public.platform_company_modules(p_company uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_platform_admin();
  return jsonb_build_object(
    'modules_off', coalesce((select to_jsonb(s.modules_off) from public.company_settings s where s.company_id = p_company), '[]'::jsonb),
    'can_set', private.modules_preset_allowed(p_company));
end;
$$;
revoke all on function public.platform_company_modules(uuid) from public, anon;
grant execute on function public.platform_company_modules(uuid) to authenticated;

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

do $$
declare
  f text;
begin
  foreach f in array array['module_on', 'modules_log', 'modules_preset_allowed', 'starter_default_hidden_areas'] loop
    if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                   where n.nspname = 'private' and p.proname = f and p.prosecdef and 'search_path=""' = any (p.proconfig)) then
      raise exception 'private.% is not installed as expected', f;
    end if;
  end loop;
end;
$$;
