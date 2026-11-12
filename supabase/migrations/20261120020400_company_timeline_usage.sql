-- Customer timeline and usage trends on the console's company page (PC1, owner 2026-11-12).
--   * public.platform_company_timeline(p_company, p_before, p_limit): one chronological list (newest first) of what
--     happened with a customer, read from the records that already hold it: the lead it came from (lead history),
--     platform actions on it (platform audit: created, terms, onboarding fee, go-live, entitlements, ...), onboarding
--     checklist events, Taviron support visits, and subscription events. Display only; it changes nothing. Amounts are
--     never included (subscription events give their kind and period only). Platform admins only.
--   * public.platform_company_usage(p_company, p_weeks): per week (Monday first, the company's time zone), loads
--     planned (not canceled), tickets delivered (not voided or replaced), how many company people made a recorded
--     change, and AI requests (counts only, never prompts, answers or costs). Up to 26 weeks. Both staff levels.
-- Reversible: supabase/rollbacks/20261120020400_company_timeline_usage.down.sql.

create or replace function public.platform_company_timeline(p_company uuid, p_before timestamptz default null, p_limit integer default 100)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 100), 1), 300);
  v_before timestamptz := coalesce(p_before, 'infinity'::timestamptz);
begin
  perform private.require_platform_admin();
  if not exists (select 1 from public.companies c where c.id = p_company) then
    raise exception 'Company not found.' using errcode = 'P0002';
  end if;
  return coalesce((select jsonb_agg(to_jsonb(t) order by t.at desc, t.source, t.kind) from (
    select * from (
      -- The lead the company was created from: its whole history.
      select e.occurred_at as at, 'lead' as source, e.action as kind, l.name as summary, e.detail,
             left(e.note, 300) as note,
             coalesce(private.person_name(e.actor_id), case when e.actor_id is null then 'Website' else 'Operator' end) as actor
      from private.leads l join private.lead_events e on e.lead_id = l.id
      where l.id in (select x.lead_id from private.lead_events x where x.action = 'company_created' and x.detail ->> 'company_id' = p_company::text)
        and e.action <> 'status_consolidated'
      union all
      -- Platform actions on the company.
      select a.occurred_at, 'platform', a.action, a.summary, '{}'::jsonb, '', coalesce(private.person_name(a.actor_id), 'Operator')
      from private.platform_audit a
      where ((a.target_type = 'company' and a.target_id = p_company::text) or a.detail ->> 'company_id' = p_company::text)
        and a.action not in ('support_entered', 'support_left') -- the visit rows below say the same, with the reason
      union all
      -- Onboarding checklist: task created, status changes, comments, documents, assignments, reminders, imports.
      select o.created_at, 'onboarding', o.kind, coalesce(k.title, ''),
             jsonb_build_object('from', o.from_status, 'to', o.to_status, 'side', o.actor_side, 'internal', o.internal),
             case when o.kind = 'comment' then left(o.body, 300) else '' end,
             coalesce(private.person_name(o.actor), case o.actor_side when 'taviron' then 'Taviron' else 'Company' end)
      from public.onboarding_events o left join public.onboarding_tasks k on k.id = o.task_id
      where o.company_id = p_company and o.kind <> 'created' -- new tasks: the platform entry says how many were added
      union all
      -- Support visits: when staff came in (and why) and when the visit ended.
      select s.started_at, 'support', 'visit_started', s.reason, jsonb_build_object('ends_at', s.ends_at), '', private.staff_name(s.user_id)
      from private.support_sessions s where s.company_id = p_company
      union all
      select coalesce(s.ended_at, s.ends_at), 'support', 'visit_ended', s.end_reason, '{}'::jsonb, '', private.staff_name(s.user_id)
      from private.support_sessions s where s.company_id = p_company and (s.ended_at is not null or s.ends_at <= now())
      union all
      -- Subscription events (kind and period only; no amounts).
      select v.created_at, 'subscription', v.kind, v.period_key, jsonb_build_object('notice', v.notice_status), '', 'Taviron'
      from private.subscription_events v where v.company_id = p_company
      union all
      -- Plan changes a person canceled (scheduled and applied ones are subscription events above).
      select coalesce(c.decided_at, c.created_at), 'subscription', 'tier_change_canceled',
             coalesce((select f.name from private.platform_plan_versions f where f.id = c.from_plan_version_id), '') || ' → ' ||
             coalesce((select t.name from private.platform_plan_versions t where t.id = c.to_plan_version_id), ''),
             '{}'::jsonb, left(c.cancel_reason, 300), coalesce(private.person_name(c.decided_by), 'Taviron')
      from private.tier_changes c where c.company_id = p_company and c.status = 'canceled'
    ) u
    where u.at < v_before
    order by u.at desc
    limit v_limit) t), '[]'::jsonb);
end;
$$;
revoke all on function public.platform_company_timeline(uuid, timestamptz, integer) from public, anon;
grant execute on function public.platform_company_timeline(uuid, timestamptz, integer) to authenticated;

create or replace function public.platform_company_usage(p_company uuid, p_weeks integer default 8)
returns table (week_start date, loads integer, tickets integer, active_people integer, ai_requests integer)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_tz text;
  v_weeks integer := least(greatest(coalesce(p_weeks, 8), 1), 26);
  v_wk date;
begin
  perform private.require_platform_staff();
  if not exists (select 1 from public.companies c where c.id = p_company) then
    raise exception 'Company not found.' using errcode = 'P0002';
  end if;
  v_tz := coalesce((select s.timezone from public.company_settings s where s.company_id = p_company), 'America/Chicago');
  v_wk := date_trunc('week', (now() at time zone v_tz)::date)::date;
  return query
    select w.d,
           (select count(*)::int from public.order_loads l where l.company_id = p_company and l.status <> 'canceled' and l.load_date between w.d and w.d + 6),
           (select count(*)::int from public.delivery_tickets t where t.company_id = p_company and t.status not in ('voided', 'superseded')
              and t.delivered_at >= (w.d::timestamp at time zone v_tz) and t.delivered_at < ((w.d + 7)::timestamp at time zone v_tz)),
           (select count(distinct e.actor_id)::int from public.audit_events e
              where e.company_id = p_company and e.actor_id is not null
                and not exists (select 1 from private.platform_admins a where a.user_id = e.actor_id)
                and e.occurred_at >= (w.d::timestamp at time zone v_tz) and e.occurred_at < ((w.d + 7)::timestamp at time zone v_tz)),
           (select count(*)::int from public.ai_usage_events i where i.company_id = p_company
              and i.created_at >= (w.d::timestamp at time zone v_tz) and i.created_at < ((w.d + 7)::timestamp at time zone v_tz))
    from (select (v_wk - 7 * g)::date as d from generate_series(0, v_weeks - 1) g) w
    order by w.d;
end;
$$;
revoke all on function public.platform_company_usage(uuid, integer) from public, anon;
grant execute on function public.platform_company_usage(uuid, integer) to authenticated;
