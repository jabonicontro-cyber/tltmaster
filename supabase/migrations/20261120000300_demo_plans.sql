-- =============================================================================
-- Plan demos (2026-10-19, master plan B63; sprint Priority 2): a demo company can be shown as Essential, Growth or
-- Professional. The platform owner switches it in Demo Management; this function reconfigures the demo so it matches
-- the plan's base count (Essential 1, Growth 2, Professional 3):
-- 1. companies.demo_plan is set (the plan limit for demos reads it; 20261120000100).
-- 2. Bases beyond the plan are deactivated and their trucks, trailers, drivers and orders move back to the default
--    base (so an Essential demo is a plain single-base company again).
-- 3. The plan's fictional bases (North Yard, South Terminal) exist and are active.
-- 4. The first time a base is used, the demo's records are spread across the bases by a stable hash of their id, so
--    the result is the same on every run; later runs move nothing (idempotent). Multi-base demos allow cross-base
--    dispatch, so Smart Dispatch keeps proposing (with the cross-base warning) on the existing fictional schedule.
-- Only demo companies (is_demo), only the platform owner, audited. A real company is refused.
-- Rollback: supabase/rollbacks/20261120000300_demo_plans.down.sql
-- =============================================================================

create or replace function public.platform_demo_set_plan(p_company uuid, p_plan text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  v_demo boolean;
  v_n integer;
  v_default uuid;
  v_codes text[] := array['NORTH', 'SOUTH'];
  v_names text[] := array['North Yard', 'South Terminal'];
  v_keep text[];
  v_bases uuid[];
  v_tz text;
  v_moved integer := 0;
  v_spread integer := 0;
  v_count integer;
  t text;
  i integer;
begin
  perform private.require_platform_admin();
  select is_demo into v_demo from public.companies where id = p_company for update;
  if not found or not v_demo then
    raise exception 'Only a demo company can switch plans here.' using errcode = '42501';
  end if;
  v_n := case p_plan when 'essential' then 1 when 'growth' then 2 when 'professional' then 3 end;
  if v_n is null then
    raise exception 'Choose Essential, Growth or Professional.' using errcode = '22023';
  end if;
  update public.companies set demo_plan = p_plan where id = p_company;
  select id, timezone into v_default, v_tz from public.dispatch_bases where company_id = p_company and is_default;
  v_keep := v_codes[1:v_n - 1];

  -- Bases beyond the plan: their records go back to the default base, then the base is deactivated.
  foreach t in array array['trucks', 'trailers', 'drivers', 'orders'] loop
    execute format('update public.%I x set base_id = $1 from public.dispatch_bases b
                    where b.id = x.base_id and b.company_id = $2 and not b.is_default and not (b.code = any($3))', t)
      using v_default, p_company, v_keep;
    get diagnostics v_count = row_count;
    v_moved := v_moved + v_count;
  end loop;
  update public.dispatch_bases set active = false where company_id = p_company and not is_default and active and not (code = any(v_keep));

  -- The plan's bases.
  -- (Update or insert, never insert-on-conflict: the plan-limit trigger runs before a conflict is detected.)
  for i in 1 .. v_n - 1 loop
    update public.dispatch_bases set active = true where company_id = p_company and code = v_codes[i] and not active;
    if not exists (select 1 from public.dispatch_bases where company_id = p_company and code = v_codes[i]) then
      insert into public.dispatch_bases (company_id, code, name, timezone, created_by)
      values (p_company, v_codes[i], v_names[i], coalesce(v_tz, 'America/Chicago'), null);
    end if;
  end loop;

  -- First use of the extra bases: spread the demo's records by a stable hash (nothing moves on later runs).
  if v_n > 1 and not exists (select 1 from public.trucks x join public.dispatch_bases b on b.id = x.base_id
                             where x.company_id = p_company and not b.is_default and b.code = any(v_keep)) then
    select array_agg(id order by array_position(v_keep, code)) into v_bases
      from public.dispatch_bases where company_id = p_company and code = any(v_keep);
    v_bases := array[v_default] || v_bases;
    foreach t in array array['trucks', 'trailers', 'drivers', 'orders'] loop
      execute format('update public.%I x set base_id = ($1::uuid[])[1 + abs(hashtext(x.id::text)) %% $2]
                      where x.company_id = $3 and x.base_id = $4 and abs(hashtext(x.id::text)) %% $2 <> 0', t)
        using v_bases, v_n, p_company, v_default;
      get diagnostics v_count = row_count;
      v_spread := v_spread + v_count;
    end loop;
  end if;

  update public.company_settings set cross_base_dispatch = (v_n > 1) where company_id = p_company;
  perform private.platform_log('demo_plan_set', 'company', p_company::text, 'Demo shown as ' || initcap(p_plan),
    jsonb_build_object('plan', p_plan, 'bases', v_n, 'moved_back', v_moved, 'spread', v_spread));
  return jsonb_build_object('plan', p_plan, 'bases', v_n, 'moved_back', v_moved, 'spread', v_spread);
end;
$$;
revoke all on function public.platform_demo_set_plan(uuid, text) from public, anon;
grant execute on function public.platform_demo_set_plan(uuid, text) to authenticated;
