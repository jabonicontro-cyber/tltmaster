-- =============================================================================
-- N14 (part 1): confirmed orders without a delivery date become visible.
--
-- Until now an order confirmed without a scheduled date appeared nowhere in
-- Dispatch (the board lists orders by date) and nowhere in the Command Center.
-- New exception kind `order_unscheduled` (visible with dispatch.view or
-- orders.view, resolved with orders.schedule), counted in the Command Center
-- summary. Functions are redefined from their current definitions with only
-- these additions.
-- =============================================================================

CREATE OR REPLACE FUNCTION private.operational_exceptions(p_company uuid)
 RETURNS TABLE(exception_key text, kind text, priority integer, since timestamp with time zone, order_id uuid, order_number text, customer_name text, load_id uuid, load_number integer, load_date date, ticket_id uuid, ticket_number text, equipment_kind text, equipment_id uuid, unit_number text, assignment_id uuid, reasons text[], details jsonb)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_today date := private.business_today(p_company);
begin
  -- Past-due loads without a live ticket (billing readiness rule).
  return query
  select 'missing_ticket:' || b.load_id, 'missing_ticket', 2,
         least(b.ends_at, coalesce(o.completed_at, b.ends_at)),
         b.order_id, b.order_number, b.customer_name, b.load_id, b.load_number, b.load_date,
         null::uuid, null::text, null::text, null::uuid, null::text, b.assignment_id,
         array_remove(array[
           case when b.voided_numbers is not null then 'ticket_voided' else 'no_ticket' end,
           case when b.assignment_id is null then 'not_assigned' end], null),
         jsonb_build_object('voided_numbers', to_jsonb(b.voided_numbers), 'order_status', b.order_status)
  from public.billing_load_status b
  join public.orders o on o.id = b.order_id and o.company_id = b.company_id
  where b.company_id = p_company and b.documentation_state = 'missing';

  -- Today's loads that have not ended and have no active assignment.
  return query
  select 'unassigned_load:' || l.id, 'unassigned_load', 1,
         coalesce((select max(a.canceled_at) from public.dispatch_assignments a
                   where a.load_id = l.id and a.company_id = l.company_id), l.created_at),
         o.id, o.order_number, c.name, l.id, l.load_number, l.load_date,
         null::uuid, null::text, null::text, null::uuid, null::text, null::uuid,
         array[case when exists (select 1 from public.dispatch_assignments a
                                 where a.load_id = l.id and a.company_id = l.company_id)
                    then 'assignment_removed' else 'no_assignment' end],
         jsonb_build_object('starts_at', l.starts_at, 'ends_at', l.ends_at)
  from public.order_loads l
  join public.orders o on o.id = l.order_id and o.company_id = l.company_id
  left join public.customers c on c.id = o.customer_id and c.company_id = o.company_id
  where l.company_id = p_company and l.status = 'planned' and l.load_date = v_today and l.ends_at > now()
    and o.status in ('scheduled', 'dispatched', 'in_progress', 'partially_completed')
    and not exists (select 1 from public.dispatch_assignments a
                    where a.load_id = l.id and a.company_id = l.company_id and a.status = 'active');

  -- Tickets waiting for review (current revisions only).
  return query
  select 'ticket_review:' || t.ticket_number, 'ticket_review', case when t.status = 'needs_review' then 2 else 3 end,
         t.created_at,
         t.order_id, t.snapshot ->> 'order_number', t.snapshot ->> 'customer_name', t.load_id,
         (t.snapshot ->> 'load_number')::int, (t.snapshot ->> 'load_date')::date,
         t.id, t.ticket_number, null::text, null::uuid, null::text, null::uuid,
         case when t.status = 'needs_review' and cardinality(t.review_reasons) > 0 then t.review_reasons
              when t.status = 'needs_review' then array['flagged_for_review']
              else array['awaiting_acceptance'] end,
         jsonb_build_object('status', t.status, 'revision', t.revision, 'review_note', t.review_note)
  from public.delivery_tickets t
  where t.company_id = p_company and t.status in ('submitted', 'needs_review');

  -- Orders documented and reviewed but blocked by unacknowledged exceptions.
  return query
  select 'billing_blocked:' || s.order_id, 'billing_blocked', 3, null::timestamptz,
         s.order_id, s.order_number, s.customer_name, null::uuid, null::int, null::date,
         null::uuid, null::text, null::text, null::uuid, null::text, null::uuid,
         array[case when s.last_acknowledged_at is not null then 'acknowledgment_outdated'
                    else 'exceptions_unacknowledged' end],
         jsonb_build_object('exceptions_count', s.exceptions_count)
  from public.billing_order_status s
  where s.company_id = p_company and s.readiness = 'blocked';

  -- Active equipment out of service, with the upcoming loads booked on it.
  return query
  select 'equipment_out_of_service:' || e.kind || ':' || e.id, 'equipment_out_of_service',
         case when e.upcoming > 0 then 2 else 3 end, e.since,
         null::uuid, null::text, null::text, null::uuid, null::int, null::date,
         null::uuid, null::text, e.kind, e.id, e.unit_number, null::uuid,
         array['out_of_service'],
         jsonb_build_object('reason', e.reason, 'expected_return_date', e.expected_return_date, 'upcoming_loads', e.upcoming)
  from (
    select 'truck' as kind, tr.id, tr.unit_number, tr.out_of_service_since as since, tr.out_of_service_reason as reason,
           tr.expected_return_date,
           (select count(*) from public.dispatch_assignments a
             where a.truck_id = tr.id and a.company_id = tr.company_id and a.status = 'active' and a.ends_at > now())::int as upcoming
    from public.trucks tr
    where tr.company_id = p_company and tr.active and tr.service_status = 'out_of_service'
    union all
    select 'trailer', tl.id, tl.unit_number, tl.out_of_service_since, tl.out_of_service_reason, tl.expected_return_date,
           (select count(*) from public.dispatch_assignments a
             where a.trailer_id = tl.id and a.company_id = tl.company_id and a.status = 'active' and a.ends_at > now())::int
    from public.trailers tl
    where tl.company_id = p_company and tl.active and tl.service_status = 'out_of_service'
  ) e;

  -- Upcoming active assignments that the dispatch rules would now refuse, or
  -- whose load falls outside the order's scheduled dates.
  return query
  select 'assignment_problem:' || x.assignment_id, 'assignment_problem',
         case when x.load_date <= v_today + 1 then 1 else 2 end, null::timestamptz,
         x.order_id, x.order_number, x.customer_name, x.load_id, x.load_number, x.load_date,
         null::uuid, null::text, null::text, null::uuid, null::text, x.assignment_id,
         x.blockers, jsonb_build_object('starts_at', x.starts_at, 'truck_id', x.truck_id, 'trailer_id', x.trailer_id, 'driver_id', x.driver_id)
  from (
    select a.id as assignment_id, a.truck_id, a.trailer_id, a.driver_id, a.starts_at,
           l.id as load_id, l.load_number, l.load_date, o.id as order_id, o.order_number, c.name as customer_name,
           array(select jsonb_array_elements_text(
                   private.assignment_eligibility(p_company, a.truck_id, a.trailer_id, a.driver_id, l.load_date) -> 'blockers'))
           || case when o.scheduled_start is null or l.load_date < o.scheduled_start
                        or l.load_date > coalesce(o.scheduled_end, o.scheduled_start)
                   then array['load_outside_schedule'] else '{}'::text[] end as blockers
    from public.dispatch_assignments a
    join public.order_loads l on l.id = a.load_id and l.company_id = a.company_id
    join public.orders o on o.id = l.order_id and o.company_id = l.company_id
    left join public.customers c on c.id = o.customer_id and c.company_id = o.company_id
    where a.company_id = p_company and a.status = 'active' and a.ends_at > now() and l.status = 'planned'
  ) x
  where cardinality(x.blockers) > 0;

  -- Driver field reports not yet resolved (one item per report).
  return query
  select 'field_report:' || r.id,
         case when r.kind in ('delay', 'cannot_complete') then 'delay_report' else 'equipment_report' end,
         case when r.status = 'acknowledged' then 3 when r.kind in ('cannot_complete', 'breakdown') then 1 else 2 end,
         r.created_at,
         r.order_id, r.snapshot ->> 'order_number', r.snapshot ->> 'customer_name', r.load_id,
         (r.snapshot ->> 'load_number')::int, (r.snapshot ->> 'load_date')::date,
         null::uuid, null::text,
         nullif(r.equipment, ''),
         case r.equipment when 'truck' then r.truck_id when 'trailer' then r.trailer_id end,
         case r.equipment when 'truck' then r.snapshot ->> 'truck_unit' when 'trailer' then r.snapshot ->> 'trailer_unit' end,
         r.assignment_id,
         array['report_' || r.kind] || case when r.status = 'acknowledged' then array['report_acknowledged'] else '{}'::text[] end,
         jsonb_build_object('report_id', r.id, 'report_kind', r.kind, 'status', r.status,
                            'driver_name', r.snapshot ->> 'driver_name', 'description', left(r.description, 300))
  from public.field_reports r
  where r.company_id = p_company and r.status in ('open', 'acknowledged');

  -- Urgent orders flagged by the office, until resolved. Unacknowledged ones
  -- (or past their deadline) are urgent; escalation follows the company setting.
  return query
  select 'urgent_order:' || u.id, 'urgent_order',
         case when u.state = 'awaiting_acknowledgement' or (u.needed_by is not null and u.needed_by < now()) then 1
              when u.state = 'assigned' then 3 else 2 end,
         u.flagged_at,
         o.id, o.order_number, c.name, null::uuid, null::int, null::date,
         null::uuid, null::text, null::text, null::uuid, null::text, null::uuid,
         array_remove(array[
           'urgent_' || u.state::text,
           case when u.state = 'awaiting_acknowledgement' and s.urgent_ack_minutes is not null
                     and u.flagged_at < now() - make_interval(mins => s.urgent_ack_minutes) then 'urgent_ack_overdue' end,
           case when u.needed_by is not null and u.needed_by < now() then 'urgent_deadline_passed' end], null),
         jsonb_build_object(
           'urgency_id', u.id, 'state', u.state, 'reason', u.reason, 'needed_by', u.needed_by, 'state_note', u.state_note,
           'flagged_by_name', (select coalesce(nullif(trim(p.full_name), ''), 'Unnamed user') from public.profiles p where p.id = u.flagged_by),
           'acknowledged_by_name', (select coalesce(nullif(trim(p.full_name), ''), 'Unnamed user') from public.profiles p where p.id = u.acknowledged_by),
           'acknowledged_at', u.acknowledged_at,
           'escalated', u.state = 'awaiting_acknowledgement' and s.urgent_ack_minutes is not null
                        and u.flagged_at < now() - make_interval(mins => s.urgent_ack_minutes),
           'order_status', o.status,
           'active_assignments', (select count(*) from public.dispatch_assignments a
                                  join public.order_loads l on l.id = a.load_id and l.company_id = a.company_id
                                  where a.company_id = u.company_id and l.order_id = o.id and a.status = 'active' and l.status = 'planned'))
  from public.order_urgencies u
  join public.orders o on o.id = u.order_id and o.company_id = u.company_id
  join public.company_settings s on s.company_id = u.company_id
  left join public.customers c on c.id = o.customer_id and c.company_id = o.company_id
  where u.company_id = p_company and u.closed_at is null;

  -- Confirmed orders with no delivery date: nothing puts them on the dispatch
  -- board until someone schedules them. Urgency follows the customer's
  -- requested date when there is one.
  return query
  select 'order_unscheduled:' || o.id, 'order_unscheduled',
         case when o.requested_date is not null and o.requested_date <= v_today + 1 then 1
              when (o.requested_date is not null and o.requested_date <= v_today + 7)
                   or o.confirmed_at < now() - interval '2 days' then 2
              else 3 end,
         coalesce(o.confirmed_at, o.updated_at),
         o.id, o.order_number, c.name, null::uuid, null::int, null::date,
         null::uuid, null::text, null::text, null::uuid, null::text, null::uuid,
         array_remove(array[
           'no_delivery_date',
           case when o.requested_date is not null and o.requested_date < v_today then 'requested_date_passed'
                when o.requested_date is not null and o.requested_date <= v_today + 1 then 'requested_date_soon' end], null),
         jsonb_build_object('requested_date', o.requested_date, 'confirmed_at', o.confirmed_at,
                            'project_name', o.project_name, 'total_cents', o.total_cents)
  from public.orders o
  left join public.customers c on c.id = o.customer_id and c.company_id = o.company_id
  where o.company_id = p_company and o.status = 'confirmed' and o.scheduled_start is null;
end;
$function$;

CREATE OR REPLACE FUNCTION private.exception_visible(p_kind text)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select case p_kind
    when 'missing_ticket'           then private.has_permission('tickets.view') or private.has_permission('billing.view')
    when 'unassigned_load'          then private.has_permission('dispatch.view')
    when 'ticket_review'            then private.has_permission('tickets.view')
    when 'billing_blocked'          then private.has_permission('billing.view')
    when 'equipment_out_of_service' then private.has_permission('fleet.view')
    when 'assignment_problem'       then private.has_permission('dispatch.view')
    when 'delay_report'             then private.field_report_visible('delay')
    when 'equipment_report'         then private.field_report_visible('breakdown')
    when 'urgent_order'             then private.has_permission('dispatch.view') or private.has_permission('orders.view')
    when 'order_unscheduled'        then private.has_permission('dispatch.view') or private.has_permission('orders.view')
    else false
  end
$function$;

CREATE OR REPLACE FUNCTION private.exception_resolve_permission(p_kind text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  select case p_kind
    when 'missing_ticket'           then 'tickets.edit'
    when 'unassigned_load'          then 'dispatch.edit'
    when 'ticket_review'            then 'tickets.review'
    when 'billing_blocked'          then 'billing.manage'
    when 'equipment_out_of_service' then 'fleet.service'
    when 'assignment_problem'       then 'dispatch.edit'
    when 'delay_report'             then 'field_reports.manage'
    when 'equipment_report'         then 'field_reports.manage'
    when 'urgent_order'             then 'dispatch.edit'
    when 'order_unscheduled'        then 'orders.schedule'
  end
$function$;

CREATE OR REPLACE FUNCTION public.exception_assignee_options()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_company uuid;
begin
  perform private.require_permission('exceptions.assign');
  v_company := private.require_company();
  return coalesce((
    select jsonb_agg(jsonb_build_object('user_id', m.user_id, 'name', coalesce(nullif(trim(p.full_name), ''), 'Unnamed user'),
                                        'role', m.role, 'kinds', k.kinds) order by p.full_name)
    from public.company_memberships m
    join public.profiles p on p.id = m.user_id
    cross join lateral (
      select coalesce(jsonb_agg(kind order by kind), '[]') as kinds
      from unnest(array['missing_ticket', 'unassigned_load', 'ticket_review', 'billing_blocked',
                        'equipment_out_of_service', 'assignment_problem',
                        'delay_report', 'equipment_report', 'urgent_order', 'order_unscheduled']) kind
      where exists (select 1 from public.role_permissions rp
                    where rp.company_id = v_company and rp.role = m.role
                      and rp.permission = private.exception_resolve_permission(kind))
        and (kind <> 'delay_report' or exists (select 1 from public.role_permissions rp
                    where rp.company_id = v_company and rp.role = m.role and rp.permission = 'dispatch.view'))
    ) k
    where m.company_id = v_company and m.active and m.role is not null and jsonb_array_length(k.kinds) > 0), '[]');
end;
$function$;

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
    where private.exception_visible(e.kind)
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
$function$;
