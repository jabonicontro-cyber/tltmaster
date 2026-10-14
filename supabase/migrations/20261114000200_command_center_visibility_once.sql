-- Command Center speed, part 2 (master plan §8 P7, 2026-10-14).
--
-- command_center_exceptions and command_center_summary checked the caller's permission for every open item
-- (private.exception_visible(e.kind) per row, several permission lookups each) and looked up the assignee's name for
-- every open item, not only the page shown. Visibility is now decided once per kind, and names are read for the
-- page's rows only. Same results and the same permission rules (private.exception_visible is unchanged and is the
-- single source of the rule).

-- The kinds the caller may see, decided once per call.
create or replace function private.visible_exception_kinds()
returns text[]
language sql
stable
set search_path = ''
as $$
  select coalesce(array_agg(k), '{}')
  from unnest(array['missing_ticket', 'unassigned_load', 'ticket_review', 'billing_blocked', 'equipment_out_of_service',
                    'assignment_problem', 'delay_report', 'equipment_report', 'urgent_order', 'order_unscheduled']) k
  where private.exception_visible(k)
$$;
revoke all on function private.visible_exception_kinds() from public, anon, authenticated;

CREATE OR REPLACE FUNCTION public.command_center_exceptions(p_kind text DEFAULT NULL::text, p_mine boolean DEFAULT false, p_limit integer DEFAULT 25, p_offset integer DEFAULT 0, p_hidden boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_company uuid := private.require_command_center();
  v_limit   integer := least(greatest(coalesce(p_limit, 25), 1), 100);
  v_offset  integer := greatest(coalesce(p_offset, 0), 0);
  v_result  jsonb;
  v_kinds   text[] := private.visible_exception_kinds();
begin
  if p_kind is not null and private.exception_resolve_permission(p_kind) is null then
    raise exception 'Unknown exception type.';
  end if;

  with visible as (
    select e.*, x.assigned_to, x.assigned_at, x.note as assignment_note,
           case when e.priority > 1 and d.hidden_until > now() then d.hidden_until end as hidden_until
    from private.operational_exceptions(v_company) e
    left join public.exception_assignments x
      on x.company_id = v_company and x.exception_key = e.exception_key and x.ended_at is null
    left join public.exception_dismissals d
      on d.company_id = v_company and d.user_id = auth.uid() and d.exception_key = e.exception_key
    where e.kind = any (v_kinds)
      and (p_kind is null or e.kind = p_kind)
      and (not coalesce(p_mine, false) or x.assigned_to = auth.uid())
  ), shown as (
    select * from visible where (hidden_until is not null) = coalesce(p_hidden, false)
  ), page as (
    -- Names only for the rows on this page (not for every open item).
    select s.*, private.comm_user_name(s.assigned_to) as assignee_name from (
      select * from shown
      order by priority, since nulls last, exception_key
      limit v_limit offset v_offset) s
  )
  select jsonb_build_object(
    'total', (select count(*) from shown),
    'hidden', (select count(*) from visible where hidden_until is not null),
    'limit', v_limit,
    'offset', v_offset,
    'items', coalesce((select jsonb_agg(to_jsonb(page) order by priority, since nulls last, exception_key) from page), '[]'))
  into v_result;
  return v_result;
end;
$function$

;

CREATE OR REPLACE FUNCTION public.command_center_summary()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_company  uuid := private.require_command_center();
  v_today    date := private.business_today(v_company);
  v_dispatch boolean := private.has_permission('dispatch.view');
  v_fleet    boolean := private.has_permission('fleet.view');
  v_billing  boolean := private.has_permission('billing.view');
  v_counts   jsonb;
  v_ex       jsonb;
  v_kinds    text[] := private.visible_exception_kinds();
begin
  select coalesce(jsonb_object_agg(kind, n), '{}'), jsonb_build_object(
           'total', coalesce(sum(n), 0), 'urgent', coalesce(sum(urgent), 0), 'mine', coalesce(sum(mine), 0),
           'hidden', coalesce(sum(hidden), 0))
  into v_counts, v_ex
  from (
    select e.kind, count(*)::int as n, count(*) filter (where e.priority = 1)::int as urgent,
           count(*) filter (where exists (select 1 from public.exception_assignments x
                                          where x.company_id = v_company and x.exception_key = e.exception_key
                                            and x.ended_at is null and x.assigned_to = auth.uid()))::int as mine,
           count(*) filter (where e.priority > 1 and exists (select 1 from public.exception_dismissals d
                                          where d.company_id = v_company and d.user_id = auth.uid()
                                            and d.exception_key = e.exception_key and d.hidden_until > now()))::int as hidden
    from private.operational_exceptions(v_company) e
    where e.kind = any (v_kinds)
    group by e.kind
  ) k;

  return jsonb_build_object(
    'as_of', now(),
    'today', v_today,
    'exceptions', v_ex,
    'by_kind', v_counts,
    'orders_today', case when private.has_permission('orders.view') then (
      select count(*) from public.orders o
      -- Same rule as the orders list filter "Scheduled today" (canceled excluded).
      where o.company_id = v_company and o.status <> 'canceled'
        and o.scheduled_start <= v_today and coalesce(o.scheduled_end, o.scheduled_start) >= v_today) end,
    'urgent_orders', case when private.exception_visible('urgent_order') then coalesce((v_counts ->> 'urgent_order')::int, 0) end,
    'loads_today', case when v_dispatch then (
      select count(*) from public.order_loads l join public.orders o on o.id = l.order_id and o.company_id = l.company_id
      where l.company_id = v_company and l.status = 'planned' and l.load_date = v_today
        and o.status in ('scheduled', 'dispatched', 'in_progress', 'partially_completed', 'completed')) end,
    'loads_today_assigned', case when v_dispatch then (
      select count(*) from public.order_loads l join public.orders o on o.id = l.order_id and o.company_id = l.company_id
      where l.company_id = v_company and l.status = 'planned' and l.load_date = v_today
        and o.status in ('scheduled', 'dispatched', 'in_progress', 'partially_completed', 'completed')
        and exists (select 1 from public.dispatch_assignments a where a.load_id = l.id and a.status = 'active')) end,
    'orders_unscheduled', case when private.exception_visible('order_unscheduled') then coalesce((v_counts ->> 'order_unscheduled')::int, 0) end,
    'unassigned_loads', case when private.exception_visible('unassigned_load') then coalesce((v_counts ->> 'unassigned_load')::int, 0) end,
    'assignment_problems', case when private.exception_visible('assignment_problem') then coalesce((v_counts ->> 'assignment_problem')::int, 0) end,
    'trucks_out_of_service', case when v_fleet then (
      select count(*) from public.trucks where company_id = v_company and active and service_status = 'out_of_service') end,
    'trailers_out_of_service', case when v_fleet then (
      select count(*) from public.trailers where company_id = v_company and active and service_status = 'out_of_service') end,
    'tickets_to_review', case when private.exception_visible('ticket_review') then coalesce((v_counts ->> 'ticket_review')::int, 0) end,
    'missing_tickets', case when private.exception_visible('missing_ticket') then coalesce((v_counts ->> 'missing_ticket')::int, 0) end,
    'billing_blocked', case when v_billing then coalesce((v_counts ->> 'billing_blocked')::int, 0) end,
    'driver_reports', case when private.has_permission('field_reports.view') then
      coalesce((v_counts ->> 'delay_report')::int, 0) + coalesce((v_counts ->> 'equipment_report')::int, 0) end,
    'billing_ready', case when v_billing then (
      select count(*) from public.billing_order_status where company_id = v_company and readiness = 'ready') end,
    'can', jsonb_build_object('dispatch', v_dispatch, 'fleet', v_fleet, 'billing', v_billing,
                              'tickets', private.has_permission('tickets.view'),
                              'orders', private.has_permission('orders.view'),
                              'assign', private.has_permission('exceptions.assign')));
end;
$function$

;
