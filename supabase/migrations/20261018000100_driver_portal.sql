-- =============================================================================
-- Driver portal and field reports (N8).
--
-- Design (docs/IMPLEMENTATION_PLAN.md §5g):
--   * A portal user is the active member of the current company whose account
--     is linked to an active driver record (drivers.user_id). Every driver
--     function resolves that driver from the session; ids sent by the browser
--     are accepted only when they belong to that driver's own active
--     assignments.
--   * Drivers get no table access. They read and write only through the
--     SECURITY DEFINER functions below, which return driver-safe fields (no
--     prices, totals, internal or scheduling notes, billing or history).
--   * Driver tickets use the same rules as office tickets: the ticket insert is
--     moved into private.create_ticket, used by submit_delivery_ticket
--     (unchanged behavior) and driver_submit_ticket. Never auto-accepted.
--   * Field reports are a new record type reviewed by office / dispatch (and
--     the shop for equipment). They never change equipment status or
--     assignments, and they appear in the command center.
--   * No photo attachments: there is no private file storage in this stack.
-- Additive. To reverse: drop the functions, triggers and the field_reports
-- table defined here, the driver.portal and field_reports.* permissions,
-- restore submit_delivery_ticket and the command center functions from
-- 20261015000100 / 20261017000100, and the exception_assignments kind check.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Permissions
-- -----------------------------------------------------------------------------
insert into public.permissions (code, category, description) values
  ('driver.portal',        'Driver portal', 'Use the driver portal: own assignments, own tickets and field reports'),
  ('field_reports.view',   'Field reports', 'View driver field reports (equipment reports only without dispatch access)'),
  ('field_reports.manage', 'Field reports', 'Acknowledge and resolve driver field reports');

insert into public.role_permission_defaults (role, permission) values
  ('driver', 'driver.portal'),
  ('owner', 'field_reports.view'), ('owner', 'field_reports.manage'),
  ('office', 'field_reports.view'), ('office', 'field_reports.manage'),
  ('dispatcher', 'field_reports.view'), ('dispatcher', 'field_reports.manage'),
  ('mechanic', 'field_reports.view'), ('mechanic', 'field_reports.manage');

insert into public.role_permissions (company_id, role, permission)
select c.id, d.role, d.permission
from public.companies c
cross join public.role_permission_defaults d
where d.permission in ('driver.portal', 'field_reports.view', 'field_reports.manage')
on conflict do nothing;

-- -----------------------------------------------------------------------------
-- 2. One ticket-creation path for office and driver
-- -----------------------------------------------------------------------------
-- Body of submit_delivery_ticket (20261015000100), unchanged except that the
-- event records a non-office source.
create or replace function private.create_ticket(p_company uuid, p_payload jsonb, p_source text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key     uuid := nullif(p_payload ->> 'submission_key', '')::uuid;
  v_t       public.delivery_tickets%rowtype;
  v_p       jsonb;
  v_status  public.ticket_status;
begin
  if v_key is not null then
    select * into v_t from public.delivery_tickets where company_id = p_company and submission_key = v_key;
    if found then
      return jsonb_build_object('ticket_id', v_t.id, 'ticket_number', v_t.ticket_number, 'status', v_t.status, 'created', false);
    end if;
  end if;

  v_p := private.prepare_ticket(p_company, p_payload, null);
  v_status := case when jsonb_array_length(v_p -> 'review_reasons') > 0 then 'needs_review' else 'submitted' end;

  insert into public.delivery_tickets (
    company_id, ticket_number, revision, status, order_id, load_id, assignment_id, order_line_id, material_id,
    truck_id, trailer_id, driver_id, delivered_at, quantity, unit_code, external_reference, notes, review_reasons,
    snapshot, submission_key, created_by)
  values (
    p_company, private.next_document_number(p_company, 'ticket'), 1, v_status,
    (v_p ->> 'order_id')::uuid, (v_p ->> 'load_id')::uuid, (v_p ->> 'assignment_id')::uuid,
    (v_p ->> 'order_line_id')::uuid, nullif(v_p ->> 'material_id', '')::uuid,
    (v_p ->> 'truck_id')::uuid, nullif(v_p ->> 'trailer_id', '')::uuid, (v_p ->> 'driver_id')::uuid,
    (v_p ->> 'delivered_at')::timestamptz, (v_p ->> 'quantity')::numeric, v_p ->> 'unit_code',
    v_p ->> 'external_reference', v_p ->> 'notes',
    array(select jsonb_array_elements_text(v_p -> 'review_reasons')), v_p -> 'snapshot', v_key, auth.uid())
  returning * into v_t;

  insert into public.delivery_ticket_events (company_id, ticket_id, ticket_number, action, from_status, to_status, note, details, actor_id)
  values (p_company, v_t.id, v_t.ticket_number, 'submitted', null, v_t.status, '',
          jsonb_build_object('review_reasons', to_jsonb(v_t.review_reasons))
            || case when p_source <> 'office' then jsonb_build_object('source', p_source) else '{}'::jsonb end,
          auth.uid());
  perform private.log_event('ticket.submitted', 'order', v_t.order_id,
    format('Ticket %s for %s load %s: %s %s%s%s', v_t.ticket_number, v_p -> 'snapshot' ->> 'order_number',
           v_p -> 'snapshot' ->> 'load_number', trim_scale(v_t.quantity), v_t.unit_code,
           case when v_t.status = 'needs_review' then ' (needs review)' else '' end,
           case when p_source = 'driver_portal' then ' — entered by the driver' else '' end),
    jsonb_build_object('ticket_id', v_t.id, 'ticket_number', v_t.ticket_number, 'load_id', v_t.load_id)
      || case when p_source <> 'office' then jsonb_build_object('source', p_source) else '{}'::jsonb end);

  return jsonb_build_object('ticket_id', v_t.id, 'ticket_number', v_t.ticket_number, 'status', v_t.status, 'created', true);
end;
$$;

create or replace function public.submit_delivery_ticket(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid;
begin
  perform private.require_permission('tickets.edit');
  v_company := private.require_company();
  return private.create_ticket(v_company, p_payload, 'office');
end;
$$;

-- -----------------------------------------------------------------------------
-- 3. The signed-in driver
-- -----------------------------------------------------------------------------
create or replace function private.portal_driver()
returns public.drivers
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid;
  v_d       public.drivers%rowtype;
begin
  perform private.require_permission('driver.portal');
  v_company := private.require_company();
  select d.* into v_d
  from public.drivers d
  join public.company_memberships m on m.company_id = d.company_id and m.user_id = d.user_id
  where d.company_id = v_company and d.user_id = auth.uid() and d.active and m.active;
  if not found then
    raise exception 'Your account is not linked to an active driver record. Ask the office to link it.' using errcode = '42501';
  end if;
  return v_d;
end;
$$;

-- Driver-safe view of the driver's active assignments in a date range. Never
-- prices, totals, internal or scheduling notes, or other drivers' work.
create or replace function private.driver_assignments(p_company uuid, p_driver uuid, p_from date, p_to date, p_assignment uuid default null)
returns table (assignment_id uuid, starts_at timestamptz, load_date date, has_live_ticket boolean, data jsonb)
language sql
stable
security definer
set search_path = ''
as $$
  select a.id, l.starts_at, l.load_date,
         exists (select 1 from public.delivery_tickets t
                 where t.load_id = l.id and t.company_id = l.company_id and t.status in ('submitted', 'needs_review', 'accepted')),
         jsonb_build_object(
           'assignment_id', a.id,
           'assignment_note', a.note,
           'load', jsonb_build_object('id', l.id, 'number', l.load_number, 'date', l.load_date, 'start_time', l.start_time,
                                      'end_time', l.end_time, 'planned_quantity', l.planned_quantity, 'unit_code', l.unit_code,
                                      'notes', l.notes),
           'order', jsonb_build_object('number', o.order_number, 'status', o.status, 'customer_name', c.name,
                                       'project_name', o.project_name, 'customer_po', o.customer_po,
                                       'contact_name', o.contact_name, 'contact_phone', o.contact_phone,
                                       'job_instructions', o.job_instructions),
           'site', jsonb_build_object('label', o.site_label, 'line1', o.site_line1, 'line2', o.site_line2, 'city', o.site_city,
                                      'state', o.site_state, 'postal_code', o.site_postal_code, 'directions', cs.directions),
           'truck', tr.unit_number,
           'trailer', tl.unit_number,
           'tickets', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'number', t.ticket_number, 'status', t.status,
                                                                    'quantity', t.quantity, 'unit_code', t.unit_code) order by t.ticket_number)
                                from public.delivery_tickets t
                                where t.load_id = l.id and t.company_id = l.company_id
                                  and t.status in ('submitted', 'needs_review', 'accepted')), '[]'),
           'can_submit_ticket', l.load_date <= private.business_today(p_company)
             and o.status in ('scheduled', 'dispatched', 'in_progress', 'partially_completed', 'completed'))
  from public.dispatch_assignments a
  join public.order_loads l on l.id = a.load_id and l.company_id = a.company_id
  join public.orders o on o.id = l.order_id and o.company_id = l.company_id
  left join public.customers c on c.id = o.customer_id and c.company_id = o.company_id
  left join public.customer_sites cs on cs.id = o.site_id and cs.company_id = o.company_id
  left join public.trucks tr on tr.id = a.truck_id and tr.company_id = a.company_id
  left join public.trailers tl on tl.id = a.trailer_id and tl.company_id = a.company_id
  where a.company_id = p_company and a.driver_id = p_driver and a.status = 'active' and l.status = 'planned'
    and l.load_date between p_from and p_to
    and o.status in ('scheduled', 'dispatched', 'in_progress', 'partially_completed', 'completed')
    and (p_assignment is null or a.id = p_assignment)
$$;

-- -----------------------------------------------------------------------------
-- 4. Field reports
-- -----------------------------------------------------------------------------
create table public.field_reports (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies (id),
  kind            text not null check (kind in ('delay', 'cannot_complete', 'breakdown', 'equipment_issue', 'inspection_issue')),
  status          text not null default 'open' check (status in ('open', 'acknowledged', 'resolved')),
  driver_id       uuid not null,
  assignment_id   uuid not null,
  load_id         uuid not null,
  order_id        uuid not null,
  equipment       text not null default '' check (equipment in ('', 'truck', 'trailer')),
  truck_id        uuid,
  trailer_id      uuid,
  description     text not null check (length(trim(description)) between 3 and 2000),
  -- Identities at report time: order/load numbers, customer, units, driver.
  snapshot        jsonb not null,
  submission_key  uuid,
  reported_by     uuid references auth.users (id) on delete set null,
  created_at      timestamptz not null default now(),
  acknowledged_by uuid references auth.users (id) on delete set null,
  acknowledged_at timestamptz,
  acknowledge_note text not null default '' check (length(acknowledge_note) <= 500),
  resolved_by     uuid references auth.users (id) on delete set null,
  resolved_at     timestamptz,
  resolution_note text not null default '' check (length(resolution_note) <= 500),
  unique (company_id, id),
  constraint field_reports_driver_fk foreign key (company_id, driver_id) references public.drivers (company_id, id),
  constraint field_reports_assignment_fk foreign key (company_id, assignment_id)
    references public.dispatch_assignments (company_id, id) on delete cascade,
  constraint field_reports_load_fk foreign key (company_id, load_id) references public.order_loads (company_id, id) on delete cascade,
  constraint field_reports_order_fk foreign key (company_id, order_id) references public.orders (company_id, id) on delete cascade,
  constraint field_reports_truck_fk foreign key (company_id, truck_id) references public.trucks (company_id, id),
  constraint field_reports_trailer_fk foreign key (company_id, trailer_id) references public.trailers (company_id, id),
  -- Equipment reports name the truck or trailer of the assignment.
  constraint field_reports_equipment check (
    (kind in ('delay', 'cannot_complete') and equipment = '')
    or (kind in ('breakdown', 'equipment_issue', 'inspection_issue')
        and ((equipment = 'truck' and truck_id is not null) or (equipment = 'trailer' and trailer_id is not null)))),
  constraint field_reports_status check (
    (status = 'open' and acknowledged_at is null and resolved_at is null)
    or (status = 'acknowledged' and acknowledged_at is not null and resolved_at is null)
    or (status = 'resolved' and resolved_at is not null and length(trim(resolution_note)) > 0))
);
create unique index field_reports_submission on public.field_reports (company_id, submission_key) where submission_key is not null;
create index field_reports_open_idx on public.field_reports (company_id, status, created_at);
create index field_reports_driver_idx on public.field_reports (company_id, driver_id, created_at desc);

-- Reports are records: only the review fields change, forward only; never
-- deleted (except with their sample order).
create or replace function private.guard_field_report()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if current_setting('tlt.sample_purge', true) = 'on' then return old; end if;
    raise exception 'Field reports cannot be deleted.' using errcode = '42501';
  end if;
  if (new.kind, new.driver_id, new.assignment_id, new.load_id, new.order_id, new.equipment, new.truck_id, new.trailer_id,
      new.description, new.snapshot, new.submission_key, new.reported_by, new.created_at)
     is distinct from
     (old.kind, old.driver_id, old.assignment_id, old.load_id, old.order_id, old.equipment, old.truck_id, old.trailer_id,
      old.description, old.snapshot, old.submission_key, old.reported_by, old.created_at)
     or (old.status = 'resolved')
     or (old.status = 'acknowledged' and new.status = 'open')
     or (old.acknowledged_at is not null and new.acknowledged_at is distinct from old.acknowledged_at) then
    raise exception 'A field report cannot be changed, only acknowledged and resolved.' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger field_reports_guard before update or delete on public.field_reports
  for each row execute function private.guard_field_report();
create trigger a_company_guard before update of company_id on public.field_reports
  for each row execute function private.forbid_company_change();

alter table public.field_reports enable row level security;
-- Delay reports concern dispatch; equipment reports also the shop.
create policy field_reports_read on public.field_reports for select to authenticated
  using (company_id = (select private.current_company_id())
         and (select private.has_permission('field_reports.view'))
         and (kind in ('breakdown', 'equipment_issue', 'inspection_issue') or (select private.has_permission('dispatch.view'))));
revoke all on public.field_reports from anon, authenticated;
grant select on public.field_reports to authenticated;
grant all on public.field_reports to service_role;

create or replace function private.field_report_visible(p_kind text)
returns boolean
language sql
stable
set search_path = ''
as $$
  select private.has_permission('field_reports.view')
     and (p_kind in ('breakdown', 'equipment_issue', 'inspection_issue') or private.has_permission('dispatch.view'))
$$;

-- -----------------------------------------------------------------------------
-- 5. Driver entry points
-- -----------------------------------------------------------------------------
-- Home: assignments today and tomorrow, earlier loads (two days) still without
-- a ticket, recent own tickets, qualification dates, own field reports.
create or replace function public.driver_portal_home()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
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
              and (t.driver_id = v_d.id or t.created_by = auth.uid())
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
$$;

-- Everything the ticket and report forms need for one of the driver's assignments.
create or replace function public.driver_assignment_form(p_assignment_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_d     public.drivers%rowtype := private.portal_driver();
  v_today date := private.business_today(v_d.company_id);
  v_data  jsonb;
  v_order uuid;
begin
  select x.data into v_data
  from private.driver_assignments(v_d.company_id, v_d.id, v_today - 2, v_today + 1, p_assignment_id) x;
  if v_data is null then
    raise exception 'This load is not assigned to you, or it is no longer current.' using errcode = '42501';
  end if;
  select l.order_id into v_order from public.dispatch_assignments a join public.order_loads l on l.id = a.load_id where a.id = p_assignment_id;
  return v_data || jsonb_build_object(
    'today', v_today,
    'timezone', private.business_timezone(v_d.company_id),
    'lines', coalesce((select jsonb_agg(jsonb_build_object('id', ol.id, 'line_no', ol.line_no, 'description', ol.description,
                                                           'unit_code', ol.unit_code) order by ol.line_no)
                       from public.order_lines ol
                       where ol.order_id = v_order and ol.company_id = v_d.company_id
                         and ol.calc_method = 'per_unit' and ol.kind <> 'discount'), '[]'),
    'units', coalesce((select jsonb_agg(jsonb_build_object('code', u.code, 'label', u.label) order by u.sort_order)
                       from public.units_of_measure u where u.company_id = v_d.company_id and u.active), '[]'));
end;
$$;

-- A ticket for the driver's own assigned load, through the shared ticket path.
-- The driver, truck and trailer come from the assignment. The submission key
-- is required, so a retry after a lost response returns the same ticket.
create or replace function public.driver_submit_ticket(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_d        public.drivers%rowtype := private.portal_driver();
  v_key      uuid := nullif(p_payload ->> 'submission_key', '')::uuid;
  v_existing public.delivery_tickets%rowtype;
  v_a        public.dispatch_assignments%rowtype;
  v_date     date;
begin
  if v_key is null then raise exception 'Missing submission key. Reload the page.'; end if;
  select * into v_existing from public.delivery_tickets where company_id = v_d.company_id and submission_key = v_key;
  if found then
    if v_existing.created_by is distinct from auth.uid() then
      raise exception 'This submission was already used.' using errcode = '42501';
    end if;
    return jsonb_build_object('ticket_id', v_existing.id, 'ticket_number', v_existing.ticket_number, 'status', v_existing.status, 'created', false);
  end if;

  select * into v_a from public.dispatch_assignments
  where id = nullif(p_payload ->> 'assignment_id', '')::uuid and company_id = v_d.company_id
    and driver_id = v_d.id and status = 'active';
  if not found then
    raise exception 'This load is not assigned to you (or the assignment changed). Refresh your list.' using errcode = '42501';
  end if;
  select load_date into v_date from public.order_loads where id = v_a.load_id;
  if v_date > private.business_today(v_d.company_id) then
    raise exception 'You can enter the ticket from the day of the load.';
  end if;

  return private.create_ticket(v_d.company_id, jsonb_build_object(
    'load_id', v_a.load_id,
    'order_line_id', p_payload -> 'order_line_id',
    'delivered_date', p_payload -> 'delivered_date',
    'delivered_time', p_payload -> 'delivered_time',
    'quantity', p_payload -> 'quantity',
    'unit_code', p_payload -> 'unit_code',
    'external_reference', p_payload -> 'external_reference',
    'notes', p_payload -> 'notes',
    'submission_key', v_key,
    'confirm_duplicate', coalesce(p_payload -> 'confirm_duplicate', 'false'::jsonb)), 'driver_portal');
end;
$$;

-- A delay, breakdown, equipment or inspection report on one of the driver's
-- own assignments (today, tomorrow or the two days before).
create or replace function public.driver_submit_field_report(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
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
$$;

-- Office / dispatch (and the shop for equipment) acknowledge and resolve.
create or replace function public.review_field_report(p_report_id uuid, p_action text, p_note text default '')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid;
  v_r       public.field_reports%rowtype;
  v_note    text := private.clean_text(p_note, 500, 'Note');
begin
  perform private.require_permission('field_reports.manage');
  v_company := private.require_company();
  select * into v_r from public.field_reports where id = p_report_id and company_id = v_company for update;
  if not found or not private.field_report_visible(v_r.kind) then raise exception 'Report not found.'; end if;

  if p_action = 'acknowledge' then
    if v_r.status <> 'open' then raise exception 'This report is already %.', v_r.status using errcode = 'PT409'; end if;
    update public.field_reports set status = 'acknowledged', acknowledged_by = auth.uid(), acknowledged_at = now(),
                                    acknowledge_note = v_note
    where id = v_r.id;
  elsif p_action = 'resolve' then
    if v_r.status = 'resolved' then raise exception 'This report is already resolved.' using errcode = 'PT409'; end if;
    if length(v_note) = 0 then raise exception 'Enter how it was resolved.'; end if;
    update public.field_reports set status = 'resolved', resolved_by = auth.uid(), resolved_at = now(), resolution_note = v_note
    where id = v_r.id;
  else
    raise exception 'Unknown action.';
  end if;

  perform private.log_event('field_report.' || case p_action when 'acknowledge' then 'acknowledged' else 'resolved' end,
    case v_r.equipment when 'truck' then 'truck' when 'trailer' then 'trailer' else 'order' end,
    case v_r.equipment when 'truck' then v_r.truck_id when 'trailer' then v_r.trailer_id else v_r.order_id end,
    format('%s report from %s %s%s', replace(initcap(replace(v_r.kind, '_', ' ')), '_', ' '), v_r.snapshot ->> 'driver_name',
           case p_action when 'acknowledge' then 'acknowledged' else 'resolved' end,
           case when length(v_note) > 0 then ': ' || v_note else '' end),
    jsonb_build_object('report_id', v_r.id));
  return jsonb_build_object('report_id', v_r.id, 'status', case p_action when 'acknowledge' then 'acknowledged' else 'resolved' end);
end;
$$;

-- -----------------------------------------------------------------------------
-- 6. Command center: driver reports as two exception kinds
-- -----------------------------------------------------------------------------
alter table public.exception_assignments drop constraint exception_assignments_kind_check;
alter table public.exception_assignments add constraint exception_assignments_kind_check
  check (kind in ('missing_ticket', 'unassigned_load', 'ticket_review', 'billing_blocked', 'equipment_out_of_service',
                  'assignment_problem', 'delay_report', 'equipment_report'));

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
    when 'delay_report'             then private.field_report_visible('delay')
    when 'equipment_report'         then private.field_report_visible('breakdown')
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
    when 'delay_report'             then 'field_reports.manage'
    when 'equipment_report'         then 'field_reports.manage'
  end
$$;

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

  -- Driver field reports not yet resolved (one item per report). A breakdown
  -- report and the truck's own out-of-service state are separate items: one
  -- is the driver's message, the other the equipment record.
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
end;
$$;

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
          or private.has_permission('billing.view') or private.has_permission('fleet.view')
          or private.has_permission('field_reports.view')) then
    raise exception 'You do not have permission to open the command center.' using errcode = '42501';
  end if;
  return v_company;
end;
$$;

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
    'driver_reports', case when private.has_permission('field_reports.view') then
      coalesce((v_counts ->> 'delay_report')::int, 0) + coalesce((v_counts ->> 'equipment_report')::int, 0) end,
    'billing_ready', case when v_billing then (
      select count(*) from public.billing_order_status where company_id = v_company and readiness = 'ready') end,
    'can', jsonb_build_object('dispatch', v_dispatch, 'fleet', v_fleet, 'billing', v_billing,
                              'tickets', private.has_permission('tickets.view'),
                              'assign', private.has_permission('exceptions.assign')));
end;
$$;

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
                        'equipment_out_of_service', 'assignment_problem',
                        'delay_report', 'equipment_report']) kind
      where exists (select 1 from public.role_permissions rp
                    where rp.company_id = v_company and rp.role = m.role
                      and rp.permission = private.exception_resolve_permission(kind))
        -- Delay reports concern dispatch: the role also needs dispatch.view.
        and (kind <> 'delay_report' or exists (select 1 from public.role_permissions rp
                    where rp.company_id = v_company and rp.role = m.role and rp.permission = 'dispatch.view'))
    ) k
    where m.company_id = v_company and m.active and m.role is not null and jsonb_array_length(k.kinds) > 0), '[]');
end;
$$;

-- Same as 20261017000100, plus: delay reports go only to people with dispatch access.
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
  if v_e.kind = 'delay_report' and not exists (select 1 from public.role_permissions
                 where company_id = v_company and role = v_role and permission = 'dispatch.view') then
    raise exception '% cannot resolve this item (needs dispatch.view).', v_name;
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

-- -----------------------------------------------------------------------------
-- 7. Grants
-- -----------------------------------------------------------------------------
revoke execute on function
  public.driver_portal_home(),
  public.driver_assignment_form(uuid),
  public.driver_submit_ticket(jsonb),
  public.driver_submit_field_report(jsonb),
  public.review_field_report(uuid, text, text)
from public, anon;
grant execute on function
  public.driver_portal_home(),
  public.driver_assignment_form(uuid),
  public.driver_submit_ticket(jsonb),
  public.driver_submit_field_report(jsonb),
  public.review_field_report(uuid, text, text)
to authenticated;

revoke execute on function
  private.create_ticket(uuid, jsonb, text),
  private.portal_driver(),
  private.driver_assignments(uuid, uuid, date, date, uuid),
  private.guard_field_report(),
  private.field_report_visible(text)
from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 8. Verification
-- -----------------------------------------------------------------------------
do $$
begin
  if (select count(*) from public.role_permissions where permission = 'driver.portal')
     <> (select count(*) from public.companies) then
    raise exception 'driver.portal was not granted to the driver role in every company';
  end if;
  if (select count(*) from public.role_permissions where permission = 'field_reports.view')
     <> 4 * (select count(*) from public.companies) then
    raise exception 'field_reports.view was not granted in every company';
  end if;
end;
$$;
