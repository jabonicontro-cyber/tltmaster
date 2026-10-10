-- =============================================================================
-- Owner command center and exception resolution (N7).
--
-- Design (docs/IMPLEMENTATION_PLAN.md §5f):
--   * Exceptions are DERIVED on every read by private.operational_exceptions
--     from the existing records and rules (billing views, eligibility rules,
--     equipment service status, tickets). Nothing is cached, so a fix made in
--     any module shows on the next load, and nothing here can mark an issue
--     resolved.
--   * One row per underlying issue (deduplication rules in §5f); each kind is
--     shown only to callers whose permissions cover its source module.
--   * The only stored state is who was asked to handle an open exception
--     (exception_assignments). It is not a status: it never hides or closes
--     the exception, and stops showing when the exception is gone.
--   * Billing audit entries on orders become visible only with billing.view.
-- Additive (the audit_read_orders policy is replaced by a narrower one). To
-- reverse: drop the functions and triggers defined here, the
-- exception_assignments table and the exceptions.assign permission, and
-- recreate audit_read_orders without the billing condition.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Permission
-- -----------------------------------------------------------------------------
insert into public.permissions (code, category, description) values
  ('exceptions.assign', 'Command center', 'Assign open exceptions in the command center to a responsible person');

insert into public.role_permission_defaults (role, permission) values
  ('owner', 'exceptions.assign'), ('office', 'exceptions.assign');

insert into public.role_permissions (company_id, role, permission)
select c.id, d.role, d.permission
from public.companies c
cross join public.role_permission_defaults d
where d.permission = 'exceptions.assign'
on conflict do nothing;

-- -----------------------------------------------------------------------------
-- 2. Billing entries in order history need billing.view
-- -----------------------------------------------------------------------------
-- Since N6, billing decisions (handoffs, acknowledgments with reasons) are
-- logged on the order. Order history stays readable with orders.view, but the
-- billing entries only with billing.view.
drop policy audit_read_orders on public.audit_events;
create policy audit_read_orders on public.audit_events for select to authenticated
  using (company_id = (select private.current_company_id())
         and entity_type = 'order'
         and (select private.has_permission('orders.view'))
         and (action not like 'billing.%' or (select private.has_permission('billing.view'))));

-- -----------------------------------------------------------------------------
-- 3. Who handles an open exception
-- -----------------------------------------------------------------------------
create table public.exception_assignments (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies (id),
  exception_key text not null check (length(exception_key) between 3 and 120),
  kind          text not null check (kind in ('missing_ticket', 'unassigned_load', 'ticket_review', 'billing_blocked',
                                              'equipment_out_of_service', 'assignment_problem')),
  assigned_to   uuid not null,
  note          text not null default '' check (length(note) <= 300),
  assigned_by   uuid references auth.users (id) on delete set null,
  assigned_at   timestamptz not null default now(),
  ended_at      timestamptz,
  ended_by      uuid references auth.users (id) on delete set null,
  end_reason    text not null default '' check (end_reason in ('', 'reassigned', 'unassigned')),
  -- The assignee is a member of the same company. Removing the member removes
  -- their assignment rows (the audit log keeps the history).
  constraint exception_assignments_member_fk foreign key (company_id, assigned_to)
    references public.company_memberships (company_id, user_id) on delete cascade,
  constraint exception_assignments_end check ((ended_at is null) = (end_reason = ''))
);
-- At most one current assignee per exception.
create unique index exception_assignments_current on public.exception_assignments (company_id, exception_key) where ended_at is null;
create index exception_assignments_assignee_idx on public.exception_assignments (company_id, assigned_to) where ended_at is null;

-- Rows only end, once; they are never edited or deleted by the app.
create or replace function private.guard_exception_assignment()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    -- Removing a member (or company) removes their rows through the foreign key.
    if not exists (select 1 from public.company_memberships
                   where company_id = old.company_id and user_id = old.assigned_to) then
      return old;
    end if;
    raise exception 'Exception assignments cannot be deleted.' using errcode = '42501';
  end if;
  if (new.exception_key, new.kind, new.assigned_to, new.note, new.assigned_by, new.assigned_at)
     is distinct from (old.exception_key, old.kind, old.assigned_to, old.note, old.assigned_by, old.assigned_at)
     or old.ended_at is not null then
    raise exception 'An exception assignment cannot be changed, only ended once.' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger exception_assignments_guard before update or delete on public.exception_assignments
  for each row execute function private.guard_exception_assignment();
create trigger a_company_guard before update of company_id on public.exception_assignments
  for each row execute function private.forbid_company_change();

alter table public.exception_assignments enable row level security;
create policy exception_assignments_read on public.exception_assignments for select to authenticated
  using (company_id = (select private.current_company_id())
         and ((select private.has_permission('exceptions.assign')) or assigned_to = (select auth.uid())));
revoke all on public.exception_assignments from anon, authenticated;
grant select on public.exception_assignments to authenticated;
grant all on public.exception_assignments to service_role;

-- -----------------------------------------------------------------------------
-- 4. Exception rules
-- -----------------------------------------------------------------------------
-- The permission that lets a person see a kind, and the one that resolves it.
create or replace function private.exception_visible(p_kind text)
returns boolean
language sql
stable
set search_path = ''
as $$
  select case p_kind
    when 'missing_ticket'           then private.has_permission('tickets.view') or private.has_permission('billing.view')
    when 'unassigned_load'          then private.has_permission('dispatch.view')
    when 'ticket_review'            then private.has_permission('tickets.view')
    when 'billing_blocked'          then private.has_permission('billing.view')
    when 'equipment_out_of_service' then private.has_permission('fleet.view')
    when 'assignment_problem'       then private.has_permission('dispatch.view')
    else false
  end
$$;

create or replace function private.exception_resolve_permission(p_kind text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_kind
    when 'missing_ticket'           then 'tickets.edit'
    when 'unassigned_load'          then 'dispatch.edit'
    when 'ticket_review'            then 'tickets.review'
    when 'billing_blocked'          then 'billing.manage'
    when 'equipment_out_of_service' then 'fleet.service'
    when 'assignment_problem'       then 'dispatch.edit'
  end
$$;

-- Every open exception of a company, one row per underlying issue.
-- priority: 1 urgent, 2 high, 3 normal. since: when the issue started, when
-- that is known reliably (null otherwise). reasons: codes explained in
-- src/lib/command-center/rules.ts. Deduplication:
--   * a due load without a live ticket is missing_ticket (also when it was
--     never assigned), never also unassigned_load; unassigned_load is only for
--     today's loads that have not ended;
--   * ticket_review lists the current revision of each pending ticket once;
--     billing_blocked lists only orders whose readiness is 'blocked' (all loads
--     documented and reviewed), so an order is never listed again for a
--     missing or pending ticket;
--   * an assignment appears once with all its blockers; equipment once per unit.
create or replace function private.operational_exceptions(p_company uuid)
returns table (
  exception_key  text,
  kind           text,
  priority       integer,
  since          timestamptz,
  order_id       uuid,
  order_number   text,
  customer_name  text,
  load_id        uuid,
  load_number    integer,
  load_date      date,
  ticket_id      uuid,
  ticket_number  text,
  equipment_kind text,
  equipment_id   uuid,
  unit_number    text,
  assignment_id  uuid,
  reasons        text[],
  details        jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $$
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
end;
$$;

-- -----------------------------------------------------------------------------
-- 5. Entry points for the app
-- -----------------------------------------------------------------------------
create or replace function private.require_command_center()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
begin
  if not (private.has_permission('dispatch.view') or private.has_permission('tickets.view')
          or private.has_permission('billing.view') or private.has_permission('fleet.view')) then
    raise exception 'You do not have permission to open the command center.' using errcode = '42501';
  end if;
  return v_company;
end;
$$;

-- Counts for the overview. A metric the caller may not see is null (never 0).
create or replace function public.command_center_summary()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
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
           'total', coalesce(sum(n), 0), 'urgent', coalesce(sum(urgent), 0), 'mine', coalesce(sum(mine), 0))
  into v_counts, v_ex
  from (
    select e.kind, count(*)::int as n, count(*) filter (where e.priority = 1)::int as urgent,
           count(*) filter (where exists (select 1 from public.exception_assignments x
                                          where x.company_id = v_company and x.exception_key = e.exception_key
                                            and x.ended_at is null and x.assigned_to = auth.uid()))::int as mine
    from private.operational_exceptions(v_company) e
    where private.exception_visible(e.kind)
    group by e.kind
  ) k;

  return jsonb_build_object(
    'as_of', now(),
    'today', v_today,
    'exceptions', v_ex,
    'by_kind', v_counts,
    'loads_today', case when v_dispatch then (
      select count(*) from public.order_loads l join public.orders o on o.id = l.order_id and o.company_id = l.company_id
      where l.company_id = v_company and l.status = 'planned' and l.load_date = v_today
        and o.status in ('scheduled', 'dispatched', 'in_progress', 'partially_completed', 'completed')) end,
    'loads_today_assigned', case when v_dispatch then (
      select count(*) from public.order_loads l join public.orders o on o.id = l.order_id and o.company_id = l.company_id
      where l.company_id = v_company and l.status = 'planned' and l.load_date = v_today
        and o.status in ('scheduled', 'dispatched', 'in_progress', 'partially_completed', 'completed')
        and exists (select 1 from public.dispatch_assignments a where a.load_id = l.id and a.status = 'active')) end,
    'unassigned_loads', case when private.exception_visible('unassigned_load') then coalesce((v_counts ->> 'unassigned_load')::int, 0) end,
    'assignment_problems', case when private.exception_visible('assignment_problem') then coalesce((v_counts ->> 'assignment_problem')::int, 0) end,
    'trucks_out_of_service', case when v_fleet then (
      select count(*) from public.trucks where company_id = v_company and active and service_status = 'out_of_service') end,
    'trailers_out_of_service', case when v_fleet then (
      select count(*) from public.trailers where company_id = v_company and active and service_status = 'out_of_service') end,
    'tickets_to_review', case when private.exception_visible('ticket_review') then coalesce((v_counts ->> 'ticket_review')::int, 0) end,
    'missing_tickets', case when private.exception_visible('missing_ticket') then coalesce((v_counts ->> 'missing_ticket')::int, 0) end,
    'billing_blocked', case when v_billing then coalesce((v_counts ->> 'billing_blocked')::int, 0) end,
    'billing_ready', case when v_billing then (
      select count(*) from public.billing_order_status where company_id = v_company and readiness = 'ready') end,
    'can', jsonb_build_object('dispatch', v_dispatch, 'fleet', v_fleet, 'billing', v_billing,
                              'tickets', private.has_permission('tickets.view'),
                              'assign', private.has_permission('exceptions.assign')));
end;
$$;

-- The attention queue: visible exceptions, highest priority and oldest first,
-- with their current assignee. Bounded: at most 100 rows per call.
create or replace function public.command_center_exceptions(
  p_kind text default null,
  p_mine boolean default false,
  p_limit integer default 25,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_command_center();
  v_limit   integer := least(greatest(coalesce(p_limit, 25), 1), 100);
  v_offset  integer := greatest(coalesce(p_offset, 0), 0);
  v_result  jsonb;
begin
  if p_kind is not null and private.exception_resolve_permission(p_kind) is null then
    raise exception 'Unknown exception type.';
  end if;

  with visible as (
    select e.*, x.assigned_to, x.assigned_at, x.note as assignment_note, p.full_name as assignee_name
    from private.operational_exceptions(v_company) e
    left join public.exception_assignments x
      on x.company_id = v_company and x.exception_key = e.exception_key and x.ended_at is null
    left join public.profiles p on p.id = x.assigned_to
    where private.exception_visible(e.kind)
      and (p_kind is null or e.kind = p_kind)
      and (not coalesce(p_mine, false) or x.assigned_to = auth.uid())
  ), page as (
    select * from visible
    order by priority, since nulls last, exception_key
    limit v_limit offset v_offset
  )
  select jsonb_build_object(
    'total', (select count(*) from visible),
    'limit', v_limit,
    'offset', v_offset,
    'items', coalesce((select jsonb_agg(to_jsonb(page) order by priority, since nulls last, exception_key) from page), '[]'))
  into v_result;
  return v_result;
end;
$$;

-- People who could be asked to handle each kind: active members whose role
-- holds the permission that resolves it. Names only (no contact details).
create or replace function public.exception_assignee_options()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
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
                        'equipment_out_of_service', 'assignment_problem']) kind
      where exists (select 1 from public.role_permissions rp
                    where rp.company_id = v_company and rp.role = m.role
                      and rp.permission = private.exception_resolve_permission(kind))
    ) k
    where m.company_id = v_company and m.active and m.role is not null and jsonb_array_length(k.kinds) > 0), '[]');
end;
$$;

-- Ask a person to handle an open exception. Refused when the exception is not
-- open (any more) or not visible to the caller, or when the person cannot
-- resolve it. Replaces a previous assignee (kept as ended).
create or replace function public.assign_exception(p_key text, p_user_id uuid, p_note text default '')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid;
  v_e       record;
  v_note    text := private.clean_text(p_note, 300, 'Note');
  v_role    public.app_role;
  v_name    text;
  v_current public.exception_assignments%rowtype;
  v_id      uuid;
begin
  perform private.require_permission('exceptions.assign');
  v_company := private.require_company();

  select * into v_e from private.operational_exceptions(v_company) e
  where e.exception_key = p_key and private.exception_visible(e.kind);
  if not found then
    raise exception 'This item is no longer open. Refresh the command center.' using errcode = 'PT409';
  end if;

  select m.role, coalesce(nullif(trim(p.full_name), ''), 'Unnamed user') into v_role, v_name
  from public.company_memberships m join public.profiles p on p.id = m.user_id
  where m.company_id = v_company and m.user_id = p_user_id and m.active and m.role is not null;
  if not found then raise exception 'Choose an active member of this company.'; end if;
  if not exists (select 1 from public.role_permissions
                 where company_id = v_company and role = v_role
                   and permission = private.exception_resolve_permission(v_e.kind)) then
    raise exception '% cannot resolve this item (needs %).', v_name, private.exception_resolve_permission(v_e.kind);
  end if;

  select * into v_current from public.exception_assignments
  where company_id = v_company and exception_key = p_key and ended_at is null for update;
  if found then
    if v_current.assigned_to = p_user_id then
      raise exception 'This item is already assigned to %.', v_name using errcode = 'PT409';
    end if;
    update public.exception_assignments set ended_at = now(), ended_by = auth.uid(), end_reason = 'reassigned'
    where id = v_current.id;
  end if;

  begin
    insert into public.exception_assignments (company_id, exception_key, kind, assigned_to, note, assigned_by)
    values (v_company, p_key, v_e.kind, p_user_id, v_note, auth.uid())
    returning id into v_id;
  exception when unique_violation then
    raise exception 'Someone else just assigned this item. Refresh and try again.' using errcode = 'PT409';
  end;

  perform private.log_event('exception.assigned',
    case when v_e.order_id is not null then 'order' else coalesce(v_e.equipment_kind, 'company') end,
    coalesce(v_e.order_id, v_e.equipment_id),
    format('%s assigned to %s%s', replace(v_e.kind, '_', ' '), v_name, case when v_note <> '' then ': ' || v_note else '' end),
    jsonb_build_object('exception_key', p_key, 'assigned_to', p_user_id, 'assignment_id', v_id));
  return jsonb_build_object('assignment_id', v_id, 'assignee', v_name);
end;
$$;

-- Clear the current assignee (also for an item that is no longer open).
create or replace function public.unassign_exception(p_key text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid;
  v_a       public.exception_assignments%rowtype;
begin
  perform private.require_permission('exceptions.assign');
  v_company := private.require_company();
  update public.exception_assignments set ended_at = now(), ended_by = auth.uid(), end_reason = 'unassigned'
  where company_id = v_company and exception_key = p_key and ended_at is null
  returning * into v_a;
  if not found then raise exception 'This item has no assignee.' using errcode = 'PT409'; end if;
  perform private.log_event('exception.unassigned', 'company', null,
    format('%s unassigned', replace(v_a.kind, '_', ' ')),
    jsonb_build_object('exception_key', p_key, 'assignment_id', v_a.id));
  return jsonb_build_object('assignment_id', v_a.id);
end;
$$;

-- -----------------------------------------------------------------------------
-- 6. Grants
-- -----------------------------------------------------------------------------
revoke execute on function
  public.command_center_summary(),
  public.command_center_exceptions(text, boolean, integer, integer),
  public.exception_assignee_options(),
  public.assign_exception(text, uuid, text),
  public.unassign_exception(text)
from public, anon;
grant execute on function
  public.command_center_summary(),
  public.command_center_exceptions(text, boolean, integer, integer),
  public.exception_assignee_options(),
  public.assign_exception(text, uuid, text),
  public.unassign_exception(text)
to authenticated;

revoke execute on function
  private.guard_exception_assignment(),
  private.exception_visible(text),
  private.exception_resolve_permission(text),
  private.operational_exceptions(uuid),
  private.require_command_center()
from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 7. Verification
-- -----------------------------------------------------------------------------
do $$
begin
  if (select count(*) from public.role_permissions where permission = 'exceptions.assign')
     <> 2 * (select count(*) from public.companies) then
    raise exception 'exceptions.assign was not granted to owner and office in every company';
  end if;
end;
$$;
