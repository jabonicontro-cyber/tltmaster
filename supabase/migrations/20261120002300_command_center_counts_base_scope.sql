-- Command Center counts follow per-person dispatch base access (master plan B62; follows 20261120001700).
--
-- 20261120001700 scoped the Command Center's items (and the counts derived from them) to the caller's dispatch bases.
-- command_center_summary also counts some records directly, with elevated rights: today's orders and loads, loads
-- assigned today, trucks and trailers out of service, and orders ready for billing. Those counts were company-wide for
-- a person limited to some bases (numbers only, no records), so their Command Center did not match their own lists.
-- They now use the same rule: unrestricted callers count everything; others count records at one of their bases or
-- without a base. Same body otherwise; same grants. No data changes.
-- Rollback: supabase/rollbacks/20261120002300_command_center_counts_base_scope.down.sql.

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
  v_bases    uuid[] := private.my_bases();
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
        and o.scheduled_start <= v_today and coalesce(o.scheduled_end, o.scheduled_start) >= v_today
        and (v_bases is null or o.base_id is null or o.base_id = any (v_bases))) end,
    'urgent_orders', case when private.exception_visible('urgent_order') then coalesce((v_counts ->> 'urgent_order')::int, 0) end,
    'loads_today', case when v_dispatch then (
      select count(*) from public.order_loads l join public.orders o on o.id = l.order_id and o.company_id = l.company_id
      where l.company_id = v_company and l.status = 'planned' and l.load_date = v_today
        and o.status in ('scheduled', 'dispatched', 'in_progress', 'partially_completed', 'completed')
        and (v_bases is null or o.base_id is null or o.base_id = any (v_bases))) end,
    'loads_today_assigned', case when v_dispatch then (
      select count(*) from public.order_loads l join public.orders o on o.id = l.order_id and o.company_id = l.company_id
      where l.company_id = v_company and l.status = 'planned' and l.load_date = v_today
        and o.status in ('scheduled', 'dispatched', 'in_progress', 'partially_completed', 'completed')
        and (v_bases is null or o.base_id is null or o.base_id = any (v_bases))
        and exists (select 1 from public.dispatch_assignments a where a.load_id = l.id and a.status = 'active')) end,
    'orders_unscheduled', case when private.exception_visible('order_unscheduled') then coalesce((v_counts ->> 'order_unscheduled')::int, 0) end,
    'unassigned_loads', case when private.exception_visible('unassigned_load') then coalesce((v_counts ->> 'unassigned_load')::int, 0) end,
    'assignment_problems', case when private.exception_visible('assignment_problem') then coalesce((v_counts ->> 'assignment_problem')::int, 0) end,
    'trucks_out_of_service', case when v_fleet then (
      select count(*) from public.trucks where company_id = v_company and active and service_status = 'out_of_service'
        and (v_bases is null or base_id is null or base_id = any (v_bases))) end,
    'trailers_out_of_service', case when v_fleet then (
      select count(*) from public.trailers where company_id = v_company and active and service_status = 'out_of_service'
        and (v_bases is null or base_id is null or base_id = any (v_bases))) end,
    'tickets_to_review', case when private.exception_visible('ticket_review') then coalesce((v_counts ->> 'ticket_review')::int, 0) end,
    'missing_tickets', case when private.exception_visible('missing_ticket') then coalesce((v_counts ->> 'missing_ticket')::int, 0) end,
    'billing_blocked', case when v_billing then coalesce((v_counts ->> 'billing_blocked')::int, 0) end,
    'driver_reports', case when private.has_permission('field_reports.view') then
      coalesce((v_counts ->> 'delay_report')::int, 0) + coalesce((v_counts ->> 'equipment_report')::int, 0) end,
    'billing_ready', case when v_billing then (
      select count(*) from public.billing_order_status b where b.company_id = v_company and b.readiness = 'ready'
        and (v_bases is null or exists (select 1 from public.orders o where o.id = b.order_id
                                        and (o.base_id is null or o.base_id = any (v_bases))))) end,
    'can', jsonb_build_object('dispatch', v_dispatch, 'fleet', v_fleet, 'billing', v_billing,
                              'tickets', private.has_permission('tickets.view'),
                              'orders', private.has_permission('orders.view'),
                              'assign', private.has_permission('exceptions.assign')));
end;
$function$;
