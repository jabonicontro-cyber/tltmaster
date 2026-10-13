-- Rollback of 20261111000300_demo_history_names.sql (not a migration; run by hand with a backup first).
-- Restores the previous definitions and drops the helper.
begin;
create or replace function public.user_directory()
returns table(id uuid, full_name text, email text)
language sql
stable
security definer
set search_path = ''
as $$
  select p.id,
         p.full_name,
         case when private.has_permission('users.manage') then p.email else '' end
  from public.company_memberships m
  join public.profiles p on p.id = m.user_id
  where m.company_id = private.current_company_id()
$$;

CREATE OR REPLACE FUNCTION public.driver_submit_field_report(p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_d       public.drivers%rowtype := private.portal_driver();
  v_today   date := private.business_today(v_d.company_id);
  v_key     uuid := nullif(p_payload ->> 'submission_key', '')::uuid;
  v_kind    text := p_payload ->> 'kind';
  v_equip   text := coalesce(nullif(p_payload ->> 'equipment', ''), '');
  v_desc    text := private.clean_text(p_payload ->> 'description', 2000, 'Description');
  v_r       public.field_reports%rowtype;
  v_a       public.dispatch_assignments%rowtype;
  v_l       public.order_loads%rowtype;
  v_o       public.orders%rowtype;
  v_truck   text;
  v_trailer text;
  v_driver  text;
begin
  if v_key is null then raise exception 'Missing submission key. Reload the page.'; end if;
  select * into v_r from public.field_reports where company_id = v_d.company_id and submission_key = v_key;
  if found then
    if v_r.reported_by is distinct from auth.uid() then
      raise exception 'This submission was already used.' using errcode = '42501';
    end if;
    return jsonb_build_object('report_id', v_r.id, 'created', false);
  end if;

  if v_kind is null or v_kind not in ('delay', 'cannot_complete', 'breakdown', 'equipment_issue', 'inspection_issue') then
    raise exception 'Choose what you are reporting.';
  end if;
  if length(v_desc) < 3 then raise exception 'Describe what happened.'; end if;

  select * into v_a from public.dispatch_assignments
  where id = nullif(p_payload ->> 'assignment_id', '')::uuid and company_id = v_d.company_id
    and driver_id = v_d.id and status = 'active';
  if not found then
    raise exception 'This load is not assigned to you (or the assignment changed). Refresh your list.' using errcode = '42501';
  end if;
  select * into v_l from public.order_loads where id = v_a.load_id;
  if v_l.load_date not between v_today - 2 and v_today + 1 then
    raise exception 'Reports can be sent for loads from two days ago to tomorrow.';
  end if;
  select * into v_o from public.orders where id = v_l.order_id;

  if v_kind in ('delay', 'cannot_complete') then
    v_equip := '';
  elsif v_equip = 'trailer' and v_a.trailer_id is null then
    raise exception 'This load has no trailer assigned.';
  elsif v_equip not in ('truck', 'trailer') then
    raise exception 'Choose the truck or the trailer.';
  end if;

  select unit_number into v_truck from public.trucks where id = v_a.truck_id;
  select unit_number into v_trailer from public.trailers where id = v_a.trailer_id;
  v_driver := coalesce((select nullif(trim(full_name), '') from public.profiles where id = v_d.user_id), nullif(trim(v_d.name), ''), 'Driver');

  insert into public.field_reports (company_id, kind, driver_id, assignment_id, load_id, order_id, equipment, truck_id, trailer_id,
                                    description, snapshot, submission_key, reported_by)
  values (v_d.company_id, v_kind, v_d.id, v_a.id, v_l.id, v_o.id, v_equip,
          case when v_equip = 'truck' or v_equip = '' then v_a.truck_id end,
          case when v_equip = 'trailer' or v_equip = '' then v_a.trailer_id end,
          v_desc,
          jsonb_build_object('order_number', v_o.order_number, 'load_number', v_l.load_number, 'load_date', v_l.load_date,
                             'customer_name', (select name from public.customers where id = v_o.customer_id),
                             'truck_unit', v_truck, 'trailer_unit', v_trailer, 'driver_name', v_driver),
          v_key, auth.uid())
  returning * into v_r;

  perform private.log_event('field_report.submitted',
    case v_equip when 'truck' then 'truck' when 'trailer' then 'trailer' else 'order' end,
    case v_equip when 'truck' then v_a.truck_id when 'trailer' then v_a.trailer_id else v_o.id end,
    format('%s reported by %s (%s load %s%s): %s', replace(initcap(replace(v_kind, '_', ' ')), '_', ' '), v_driver,
           v_o.order_number, v_l.load_number,
           case v_equip when 'truck' then ', truck ' || v_truck when 'trailer' then ', trailer ' || v_trailer else '' end,
           left(v_desc, 160)),
    jsonb_build_object('report_id', v_r.id, 'kind', v_kind, 'assignment_id', v_a.id));
  return jsonb_build_object('report_id', v_r.id, 'created', true);
end;
$function$;

CREATE OR REPLACE FUNCTION public.driver_portal_home()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_d     public.drivers%rowtype := private.portal_driver();
  v_today date := private.business_today(v_d.company_id);
begin
  return jsonb_build_object(
    'driver', jsonb_build_object('name', coalesce((select nullif(trim(p.full_name), '') from public.profiles p where p.id = v_d.user_id),
                                                  nullif(trim(v_d.name), ''), 'Driver')),
    'today', v_today,
    'timezone', private.business_timezone(v_d.company_id),
    'assignments', coalesce((
      select jsonb_agg(x.data order by x.starts_at)
      from private.driver_assignments(v_d.company_id, v_d.id, v_today - 2, v_today + 1) x
      where x.load_date >= v_today or not x.has_live_ticket), '[]'),
    'tickets', coalesce((
      select jsonb_agg(jsonb_build_object('id', t.id, 'number', t.ticket_number, 'revision', t.revision, 'status', t.status,
                                          'quantity', t.quantity, 'unit_code', t.unit_code, 'delivered_at', t.delivered_at,
                                          'order_number', t.snapshot ->> 'order_number', 'load_number', t.snapshot ->> 'load_number',
                                          'review_reasons', to_jsonb(t.review_reasons)) order by t.created_at desc)
      from (select * from public.delivery_tickets t
            where t.company_id = v_d.company_id and t.status <> 'superseded'
              and t.driver_id = v_d.id
            order by t.created_at desc limit 10) t), '[]'),
    'qualifications', coalesce((
      select jsonb_agg(jsonb_build_object('kind', q.kind, 'cdl_class', q.cdl_class, 'expires_on', q.expires_on,
                                          'verified', q.verified_at is not null, 'description', q.description) order by q.kind, q.expires_on)
      from public.driver_qualifications q where q.company_id = v_d.company_id and q.driver_id = v_d.id), '[]'),
    'reports', coalesce((
      select jsonb_agg(jsonb_build_object('id', r.id, 'kind', r.kind, 'status', r.status, 'created_at', r.created_at,
                                          'order_number', r.snapshot ->> 'order_number', 'load_number', r.snapshot ->> 'load_number',
                                          'equipment_unit', case r.equipment when 'truck' then r.snapshot ->> 'truck_unit'
                                                                             when 'trailer' then r.snapshot ->> 'trailer_unit' end)
                       order by r.created_at desc)
      from (select * from public.field_reports r
            where r.company_id = v_d.company_id and r.driver_id = v_d.id
            order by r.created_at desc limit 10) r), '[]'));
end;
$function$;

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
CREATE OR REPLACE FUNCTION private.assignment_label(p_truck_id uuid, p_trailer_id uuid, p_driver_id uuid)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select concat_ws(', ',
    'truck ' || (select unit_number from public.trucks where id = p_truck_id),
    'trailer ' || (select unit_number from public.trailers where id = p_trailer_id),
    'driver ' || (select coalesce(nullif(trim(p.full_name), ''), nullif(d.name, ''), 'unnamed')
                  from public.drivers d left join public.profiles p on p.id = d.user_id where d.id = p_driver_id))
$function$;
drop function if exists private.demo_person_name(uuid, uuid);
commit;
