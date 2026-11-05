-- Rollback of 20261120007400_starter_plan.sql. Refuses while any company is on the Starter plan (move it to another
-- plan in /admin first), so no company loses its plan.
do $$
begin
  if exists (select 1 from private.company_lifecycle l join private.platform_plan_versions v on v.id = l.plan_version_id where v.plan_key = 'starter') then
    raise exception 'A company is on the Starter plan; move it to another plan before rolling back.';
  end if;
end;
$$;

delete from private.platform_plan_versions where plan_key = 'starter';
alter table private.platform_plan_versions drop constraint platform_plan_versions_plan_key_check;
alter table private.platform_plan_versions add constraint platform_plan_versions_plan_key_check
  check (plan_key in ('essential', 'growth', 'professional', 'enterprise', 'custom'));

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
          order by array_position(array['essential', 'growth', 'professional', 'enterprise', 'custom'], v.plan_key), v.version desc), '[]')
          from private.platform_plan_versions v);
end;
$$;
revoke all on function public.platform_plans() from public, anon;
grant execute on function public.platform_plans() to authenticated;
