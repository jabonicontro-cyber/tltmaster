-- =============================================================================
-- Starter plan (owner 2026-11-05, master plan §5.1 and SF2): small fleets of up to 10 hauling trucks and one dispatch
-- base, $249 a month, $99 onboarding. The owner asked Claude to set the price from the existing tiers and the market
-- research; it is the lowest tier, so the "lowest tier that covers both limits" rule picks it for 1-10 trucks.
--
-- 1. 'starter' becomes an allowed plan key, and its first version is added to the platform's plan catalog.
-- 2. platform_plans() lists Starter first (same function otherwise, unchanged signature and grants).
-- Companies already on a plan keep their plan; nothing else changes.
-- Rollback: supabase/rollbacks/20261120007400_starter_plan.down.sql
-- =============================================================================

alter table private.platform_plan_versions drop constraint platform_plan_versions_plan_key_check;
alter table private.platform_plan_versions add constraint platform_plan_versions_plan_key_check
  check (plan_key in ('starter', 'essential', 'growth', 'professional', 'enterprise', 'custom'));

insert into private.platform_plan_versions (plan_key, name, version, monthly_cents, onboarding_cents, from_price, trucks, bases, effective_from, note)
select 'starter', 'Starter', 1, 24900, 9900, false, 10, 1, '2026-11-05', 'Small fleets, owner 2026-11-05 (master plan §5.1)'
where not exists (select 1 from private.platform_plan_versions where plan_key = 'starter');

create or replace function public.platform_plans()
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $$
begin
  perform private.require_platform_admin();
  return (select coalesce(jsonb_agg(jsonb_build_object(
            'id', v.id, 'plan_key', v.plan_key, 'name', v.name, 'version', v.version, 'monthly_cents', v.monthly_cents,
            'onboarding_cents', v.onboarding_cents, 'from_price', v.from_price, 'trucks', v.trucks, 'bases', v.bases,
            'effective_from', v.effective_from, 'note', v.note, 'created_at', v.created_at,
            'companies', (select count(*) from private.company_lifecycle l where l.plan_version_id = v.id),
            'current', v.id = (select w.id from private.platform_plan_versions w where w.plan_key = v.plan_key and w.effective_from <= current_date
                               order by w.effective_from desc, w.version desc limit 1))
          order by array_position(array['starter', 'essential', 'growth', 'professional', 'enterprise', 'custom'], v.plan_key), v.version desc), '[]')
          from private.platform_plan_versions v);
end;
$$;
revoke all on function public.platform_plans() from public, anon;
grant execute on function public.platform_plans() to authenticated;
