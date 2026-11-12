-- Company health at a glance (PC1, owner 2026-11-12: "full of features that would be useful for Taviron staff").
-- public.platform_company_health(p_company): for each active company (or the one company asked for), counts only — no
-- business records, names, amounts or contents:
--   * people: active members; the last time any of them signed in; how many were active (signed in or made a recorded
--     change) in the last 7 and 30 days. Taviron staff are never counted (their visits are counted separately).
--   * work: loads planned for this week and last week (not canceled), delivery tickets delivered this week and last week
--     (not voided or replaced), open critical and action-required alerts; the company's own week (Monday first, its
--     time zone).
--   * the last recorded change by a company person, support visits in the last 30 days and the last one, and the stage
--     (private.company_stage, 20261120020200).
-- Both staff levels may read it (Support only for companies they could enter, private.platform_staff_may_see); anyone
-- else is refused. The company id is only the one the staff
-- member picked; nothing is written. Reversible: supabase/rollbacks/20261120020300_company_health.down.sql.

-- Which companies a staff member may see in these reads (security review 2026-11-12, M1): Admins every company; Support
-- only the companies they could enter (no owner grant needed, or the owner's grant is open), the same rule as support
-- visits (private.support_needs_grant, private.support_open_grant, 20261120008900). A live customer's activity is not
-- visible to Support without the owner's grant.
create or replace function private.platform_staff_may_see(p_company uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select a.level = 'admin' from private.platform_admins a where a.user_id = auth.uid() and a.revoked_at is null), false)
      or not private.support_needs_grant(p_company)
      or private.support_open_grant(p_company) is not null
$$;
revoke all on function private.platform_staff_may_see(uuid) from public, anon, authenticated;

create or replace function public.platform_company_health(p_company uuid default null)
returns table (company_id uuid, name text, is_demo boolean, active boolean, stage text, created_at timestamptz,
               members integer, last_sign_in_at timestamptz, active_7d integer, active_30d integer,
               loads_this_week integer, loads_last_week integer, tickets_this_week integer, tickets_last_week integer,
               alerts_critical integer, alerts_action integer, last_activity_at timestamptz,
               support_visits_30d integer, last_support_visit_at timestamptz, week_start date)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_platform_staff();
  return query
    with co as (
      select c.id, c.name, c.is_demo, c.active, c.created_at,
             date_trunc('week', (now() at time zone coalesce((select s.timezone from public.company_settings s where s.company_id = c.id), 'America/Chicago'))::date)::date as wk,
             coalesce((select s.timezone from public.company_settings s where s.company_id = c.id), 'America/Chicago') as tz
      from public.companies c
      where ((p_company is null and c.active and c.archived_at is null) or c.id = p_company)
        and private.platform_staff_may_see(c.id)
    ), staff as (
      select a.user_id from private.platform_admins a
    ), people as (
      select m.company_id, m.user_id, u.last_sign_in_at
      from public.company_memberships m join auth.users u on u.id = m.user_id
      where m.active and m.company_id in (select id from co) and m.user_id not in (select user_id from staff)
    ), changes as (
      select e.company_id, e.actor_id, max(e.occurred_at) as last_at
      from public.audit_events e
      where e.company_id in (select id from co) and e.occurred_at > now() - interval '30 days'
        and e.actor_id is not null and e.actor_id not in (select user_id from staff)
      group by e.company_id, e.actor_id
    )
    select co.id, co.name, co.is_demo, co.active, private.company_stage(co.id), co.created_at,
           (select count(*)::int from people p where p.company_id = co.id),
           (select max(p.last_sign_in_at) from people p where p.company_id = co.id),
           (select count(distinct x.user_id)::int from (
              select p.user_id from people p where p.company_id = co.id and p.last_sign_in_at > now() - interval '7 days'
              union select ch.actor_id from changes ch where ch.company_id = co.id and ch.last_at > now() - interval '7 days') x),
           (select count(distinct x.user_id)::int from (
              select p.user_id from people p where p.company_id = co.id and p.last_sign_in_at > now() - interval '30 days'
              union select ch.actor_id from changes ch where ch.company_id = co.id) x),
           (select count(*)::int from public.order_loads l where l.company_id = co.id and l.status <> 'canceled'
              and l.load_date between co.wk and co.wk + 6),
           (select count(*)::int from public.order_loads l where l.company_id = co.id and l.status <> 'canceled'
              and l.load_date between co.wk - 7 and co.wk - 1),
           (select count(*)::int from public.delivery_tickets t where t.company_id = co.id and t.status not in ('voided', 'superseded')
              and (t.delivered_at at time zone co.tz)::date between co.wk and co.wk + 6),
           (select count(*)::int from public.delivery_tickets t where t.company_id = co.id and t.status not in ('voided', 'superseded')
              and (t.delivered_at at time zone co.tz)::date between co.wk - 7 and co.wk - 1),
           (select count(*)::int from public.alerts a where a.company_id = co.id and a.status = 'open' and a.priority = 'critical'),
           (select count(*)::int from public.alerts a where a.company_id = co.id and a.status = 'open' and a.priority = 'action_required'),
           (select max(e.occurred_at) from public.audit_events e
              where e.company_id = co.id and e.actor_id is not null and e.actor_id not in (select user_id from staff)),
           (select count(*)::int from private.support_sessions s where s.company_id = co.id and s.started_at > now() - interval '30 days'),
           (select max(s.started_at) from private.support_sessions s where s.company_id = co.id),
           co.wk
    from co
    order by co.is_demo, co.name;
end;
$$;
revoke all on function public.platform_company_health(uuid) from public, anon;
grant execute on function public.platform_company_health(uuid) to authenticated;
