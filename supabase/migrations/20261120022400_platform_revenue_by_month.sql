-- Revenue over time for the platform console (PC2, owner decision 2026-11-14: "Yes, Admin only").
-- AGREED monthly revenue, month by month, from what was recorded: never collected money (there is no payment system).
--   * A customer counts from the day it went live (company_lifecycle.live_at) until it was canceled or archived, in the
--     company's own time zone. Demo and practice companies never count.
--   * The agreed monthly amount on a day is the latest recorded agreement on or before that day: the plan and terms the
--     platform team set (platform audit 'lifecycle_terms_set', with the amount) or a scheduled plan change that took
--     effect (subscription_events 'tier_change_applied', on its effective date). A company with no such record uses its
--     current agreed amount; when the amount before the first record is not recorded, the month says "not recorded"
--     instead of guessing.
--   * Each month shows the position at its last day (the current month: today), the change from the month before, the
--     customers who went live and those who ended (canceled or archived) in it. Nothing is prorated or computed as a
--     bill: these are the agreed monthly amounts as recorded.
--   * Upcoming: annual renewals in the next 90 days (with whether renewal is off) and scheduled plan changes.
-- Admin only (private.require_platform_admin, which also requires two-step verification); Support and company users are
-- refused. Read only: nothing is written. Reversible: supabase/rollbacks/20261120022400_platform_revenue_by_month.down.sql.

-- The agreed monthly amount of a company on a day (its own calendar day), or null when it is not recorded.
create or replace function private.agreed_monthly_on(p_company uuid, p_day date)
returns integer language sql stable security definer set search_path = '' as $$
  with z as (
    select coalesce(nullif(s.timezone, ''), 'UTC') as tz
    from (select 1) o left join public.company_settings s on s.company_id = p_company
  ),
  ev as (
    select (a.occurred_at at time zone z.tz)::date as day, a.occurred_at as at,
           (a.detail ->> 'agreed_monthly_cents')::integer as cents, (a.detail ->> 'previous_agreed_monthly_cents')::integer as prev
    from private.platform_audit a cross join z
    where a.action = 'lifecycle_terms_set' and a.target_type = 'company' and a.target_id = p_company::text
    union all
    select (e.detail ->> 'effective_on')::date, e.created_at, (e.detail ->> 'agreed_monthly_cents')::integer, null
    from private.subscription_events e
    where e.company_id = p_company and e.kind = 'tier_change_applied' and e.detail ? 'effective_on'
  )
  select case
    when not exists (select 1 from ev) then (select l.agreed_monthly_cents from private.company_lifecycle l where l.company_id = p_company)
    else coalesce((select ev.cents from ev where ev.day <= p_day order by ev.day desc, ev.at desc limit 1),
                  (select ev.prev from ev order by ev.day, ev.at limit 1))
  end
$$;
revoke all on function private.agreed_monthly_on(uuid, date) from public, anon, authenticated;

create or replace function public.platform_revenue_by_month(p_months integer default 12)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_months integer := coalesce(p_months, 12);
  v_this   date := date_trunc('month', current_date)::date;
  v_first  date;
  v_out    jsonb;
begin
  perform private.require_platform_admin();
  if v_months < 1 or v_months > 36 then
    raise exception 'Choose between 1 and 36 months.' using errcode = '22023';
  end if;
  v_first := (v_this - make_interval(months => v_months - 1))::date;

  with subs as (
    select c.id, c.name, l.stage, l.terms, l.renewal_off, l.commitment_start, l.agreed_monthly_cents as cur, v.name as plan_name,
           (l.live_at at time zone z.tz)::date as start_day,
           nullif(least(case when l.stage = 'canceled' and l.canceled_at is not null then (l.canceled_at at time zone z.tz)::date else 'infinity'::date end,
                        coalesce((c.archived_at at time zone z.tz)::date, 'infinity'::date)), 'infinity'::date) as end_day,
           (now() at time zone z.tz)::date as today
    from public.companies c
    join private.company_lifecycle l on l.company_id = c.id
    left join public.company_settings s on s.company_id = c.id
    cross join lateral (select coalesce(nullif(s.timezone, ''), 'UTC') as tz) z
    left join private.platform_plan_versions v on v.id = l.plan_version_id
    where not c.is_demo and c.classification = 'production' and l.live_at is not null
  ),
  -- One month before the first shown, for the first month's change.
  m as (
    select g::date as m_start, (g + interval '1 month' - interval '1 day')::date as m_end
    from generate_series(v_first - interval '1 month', v_this::timestamp, interval '1 month') g
  ),
  snap as (
    select m.m_start, x.id, private.agreed_monthly_on(x.id, d.day) as cents
    from m cross join subs x
    cross join lateral (select least(m.m_end, x.today) as day) d
    where x.start_day <= d.day and (x.end_day is null or d.day < x.end_day)
  ),
  per as (
    select m.m_start, m.m_end,
           count(s.id)::integer as customers,
           (count(s.id) filter (where s.cents > 0))::integer as paying,
           (count(s.id) filter (where s.cents = 0))::integer as free,
           (count(s.id) filter (where s.cents is null))::integer as not_recorded,
           coalesce(sum(s.cents), 0)::bigint as agreed
    from m left join snap s on s.m_start = m.m_start
    group by m.m_start, m.m_end
  ),
  per2 as (select per.*, per.agreed - lag(per.agreed) over (order by per.m_start) as change from per)
  select jsonb_build_object(
    'as_of', now(),
    'first_month', v_first,
    'months', (select coalesce(jsonb_agg(jsonb_build_object(
        'month', to_char(p.m_start, 'YYYY-MM'), 'month_start', p.m_start, 'month_end', p.m_end, 'current', p.m_start = v_this,
        'customers', p.customers, 'paying', p.paying, 'free', p.free, 'not_recorded', p.not_recorded,
        'agreed_cents', p.agreed, 'change_cents', p.change,
        'new', (select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'name', x.name, 'cents', private.agreed_monthly_on(x.id, x.start_day)) order by x.name), '[]'::jsonb)
                from subs x where x.start_day between p.m_start and p.m_end),
        'lost', (select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'name', x.name, 'cents', private.agreed_monthly_on(x.id, x.end_day - 1),
                                                              'canceled', x.stage = 'canceled') order by x.name), '[]'::jsonb)
                 from subs x where x.end_day between p.m_start and p.m_end)
      ) order by p.m_start), '[]'::jsonb) from per2 p where p.m_start >= v_first),
    'renewals', (select coalesce(jsonb_agg(jsonb_build_object(
        'company_id', x.id, 'name', x.name, 'renews_on', n.renews_on, 'days', n.renews_on - x.today,
        'agreed_monthly_cents', x.cur, 'renewal_off', x.renewal_off, 'plan', x.plan_name) order by n.renews_on, x.name), '[]'::jsonb)
      from subs x
      cross join lateral (select (x.commitment_start + make_interval(years => greatest(0, extract(year from age(x.today, x.commitment_start))::integer) + 1))::date as renews_on) n
      where x.end_day is null and x.stage = 'live' and x.terms = 'annual' and x.commitment_start is not null and n.renews_on <= x.today + 90),
    'scheduled_changes', (select coalesce(jsonb_agg(jsonb_build_object(
        'company_id', x.id, 'name', x.name, 'effective_on', t.effective_on, 'agreed_monthly_cents', t.agreed_monthly_cents,
        'current_cents', x.cur, 'plan', pv.name) order by t.effective_on, x.name), '[]'::jsonb)
      from private.tier_changes t join subs x on x.id = t.company_id
      left join private.platform_plan_versions pv on pv.id = t.to_plan_version_id
      where t.status = 'scheduled' and x.end_day is null),
    -- Agreed but not live yet (fee due or onboarding): not counted above.
    'not_live_yet', (select jsonb_build_object('companies', count(*)::integer, 'agreed_cents', coalesce(sum(l.agreed_monthly_cents), 0))
      from private.company_lifecycle l join public.companies c on c.id = l.company_id
      where not c.is_demo and c.classification = 'production' and c.archived_at is null and l.stage in ('fee_due', 'onboarding'))
  ) into v_out;
  return v_out;
end;
$$;
revoke all on function public.platform_revenue_by_month(integer) from public, anon;
grant execute on function public.platform_revenue_by_month(integer) to authenticated;
