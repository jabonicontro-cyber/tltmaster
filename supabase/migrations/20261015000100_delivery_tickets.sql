-- =============================================================================
-- Delivery tickets (N5) — the operational record of what was delivered.
--
-- Design (docs/IMPLEMENTATION_PLAN.md §5d):
--   * delivery_tickets holds one row per revision. A correction inserts a new
--     revision and marks the previous one 'superseded'; nothing is overwritten.
--   * Each revision references the load, order, assignment, order line, truck,
--     trailer and driver of the same company, and keeps a snapshot of their
--     identities so later reassignment or renaming never changes the record.
--   * Quantities are entered with an explicit unit. No unit is defaulted and no
--     conversion between units is ever made; a unit that differs from the order
--     line's unit is flagged for review instead.
--   * Writes only through SECURITY DEFINER functions that resolve the caller's
--     company and permissions. Tickets never change order status, pricing or
--     billing.
-- Additive. To reverse: drop the functions and triggers defined here, the two
-- tables, the ticket_status type, the order_lines_company_id_id_key
-- constraint and the tickets.* permissions.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Permissions
-- -----------------------------------------------------------------------------
insert into public.permissions (code, category, description) values
  ('tickets.view',   'Delivery tickets', 'View delivery tickets and their history'),
  ('tickets.edit',   'Delivery tickets', 'Enter delivery tickets and correct tickets that are not accepted yet'),
  ('tickets.review', 'Delivery tickets', 'Accept, flag and void delivery tickets, and correct accepted tickets');

insert into public.role_permission_defaults (role, permission) values
  ('owner', 'tickets.view'), ('owner', 'tickets.edit'), ('owner', 'tickets.review'),
  ('office', 'tickets.view'), ('office', 'tickets.edit'), ('office', 'tickets.review'),
  ('dispatcher', 'tickets.view'), ('dispatcher', 'tickets.edit');

insert into public.role_permissions (company_id, role, permission)
select c.id, d.role, d.permission
from public.companies c
cross join public.role_permission_defaults d
where d.permission like 'tickets.%'
on conflict do nothing;

-- -----------------------------------------------------------------------------
-- 2. Tables
-- -----------------------------------------------------------------------------
-- Same-company references to order lines (id is already unique).
alter table public.order_lines add constraint order_lines_company_id_id_key unique (company_id, id);

create type public.ticket_status as enum ('submitted', 'needs_review', 'accepted', 'voided', 'superseded');

create table public.delivery_tickets (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null references public.companies (id),
  ticket_number      text not null,
  revision           integer not null default 1 check (revision > 0),
  supersedes_id      uuid references public.delivery_tickets (id),
  status             public.ticket_status not null,
  order_id           uuid not null,
  load_id            uuid not null,
  assignment_id      uuid not null,
  order_line_id      uuid not null,
  material_id        uuid,
  truck_id           uuid not null,
  trailer_id         uuid,
  driver_id          uuid not null,
  delivered_at       timestamptz not null,
  quantity           numeric(12,3) not null check (quantity > 0 and quantity <= 999999.999),
  unit_code          text not null,
  external_reference text not null default '' check (length(external_reference) <= 60),
  notes              text not null default '' check (length(notes) <= 2000),
  review_reasons     text[] not null default '{}',
  -- Identities at delivery time: order/load numbers, customer, line, truck,
  -- trailer and driver names, planned quantity.
  snapshot           jsonb not null,
  correction_reason  text not null default '',
  submission_key     uuid,
  reviewed_by        uuid references auth.users (id) on delete set null,
  reviewed_at        timestamptz,
  review_note        text not null default '',
  voided_by          uuid references auth.users (id) on delete set null,
  voided_at          timestamptz,
  void_reason        text not null default '',
  created_by         uuid references auth.users (id) on delete set null,
  created_at         timestamptz not null default now(),
  unique (company_id, id),
  unique (company_id, ticket_number, revision),
  constraint delivery_tickets_order_fk foreign key (company_id, order_id)
    references public.orders (company_id, id) on delete cascade,
  constraint delivery_tickets_load_fk foreign key (company_id, load_id)
    references public.order_loads (company_id, id) on delete cascade,
  constraint delivery_tickets_assignment_fk foreign key (company_id, assignment_id)
    references public.dispatch_assignments (company_id, id) on delete cascade,
  constraint delivery_tickets_line_fk foreign key (company_id, order_line_id)
    references public.order_lines (company_id, id) on delete cascade,
  constraint delivery_tickets_material_fk foreign key (company_id, material_id)
    references public.materials (company_id, id),
  constraint delivery_tickets_truck_fk foreign key (company_id, truck_id)
    references public.trucks (company_id, id),
  constraint delivery_tickets_trailer_fk foreign key (company_id, trailer_id)
    references public.trailers (company_id, id),
  constraint delivery_tickets_driver_fk foreign key (company_id, driver_id)
    references public.drivers (company_id, id),
  constraint delivery_tickets_unit_fk foreign key (company_id, unit_code)
    references public.units_of_measure (company_id, code),
  constraint delivery_tickets_revision check ((revision = 1) = (supersedes_id is null)),
  constraint delivery_tickets_correction check (revision = 1 or length(trim(correction_reason)) > 0),
  constraint delivery_tickets_void check (
    (status = 'voided') = (voided_at is not null) and (status <> 'voided' or length(trim(void_reason)) > 0))
);
-- One current revision per ticket number.
create unique index delivery_tickets_current on public.delivery_tickets (company_id, ticket_number) where status <> 'superseded';
-- A repeated submission (double click, retry) returns the same ticket.
create unique index delivery_tickets_submission on public.delivery_tickets (company_id, submission_key) where submission_key is not null;
create index delivery_tickets_load_idx on public.delivery_tickets (load_id);
create index delivery_tickets_order_idx on public.delivery_tickets (order_id);
create index delivery_tickets_status_idx on public.delivery_tickets (company_id, status, delivered_at desc);
create index delivery_tickets_reference_idx on public.delivery_tickets (company_id, lower(external_reference)) where external_reference <> '';

create table public.delivery_ticket_events (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies (id),
  ticket_id     uuid not null,
  ticket_number text not null,
  action        text not null check (action in ('submitted', 'flagged', 'accepted', 'voided', 'corrected')),
  from_status   public.ticket_status,
  to_status     public.ticket_status not null,
  note          text not null default '',
  details       jsonb not null default '{}',
  actor_id      uuid references auth.users (id) on delete set null,
  occurred_at   timestamptz not null default now(),
  constraint delivery_ticket_events_ticket_fk foreign key (company_id, ticket_id)
    references public.delivery_tickets (company_id, id) on delete cascade
);
create index delivery_ticket_events_number_idx on public.delivery_ticket_events (company_id, ticket_number, occurred_at);

-- Revisions are records: only the review/void fields and the status change,
-- along the allowed paths; rows are never deleted (except with their sample
-- order by the owner-only sample purge).
create or replace function private.guard_delivery_ticket()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if current_setting('tlt.sample_purge', true) = 'on' then
      return old;
    end if;
    raise exception 'Delivery tickets cannot be deleted. Void them instead.' using errcode = '42501';
  end if;
  if (new.ticket_number, new.revision, new.supersedes_id, new.order_id, new.load_id, new.assignment_id,
      new.order_line_id, new.material_id, new.truck_id, new.trailer_id, new.driver_id, new.delivered_at,
      new.quantity, new.unit_code, new.external_reference, new.notes, new.review_reasons, new.snapshot,
      new.correction_reason, new.submission_key, new.created_by, new.created_at)
     is distinct from
     (old.ticket_number, old.revision, old.supersedes_id, old.order_id, old.load_id, old.assignment_id,
      old.order_line_id, old.material_id, old.truck_id, old.trailer_id, old.driver_id, old.delivered_at,
      old.quantity, old.unit_code, old.external_reference, old.notes, old.review_reasons, old.snapshot,
      old.correction_reason, old.submission_key, old.created_by, old.created_at) then
    raise exception 'A submitted ticket cannot be edited. Use a correction.' using errcode = '42501';
  end if;
  if new.status is distinct from old.status and not (
       (old.status in ('submitted', 'needs_review') and new.status in ('accepted', 'needs_review', 'voided', 'superseded'))
    or (old.status = 'accepted' and new.status in ('needs_review', 'voided', 'superseded'))) then
    raise exception 'A % ticket cannot become %.', old.status, new.status using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger delivery_tickets_guard before update or delete on public.delivery_tickets
  for each row execute function private.guard_delivery_ticket();
create trigger delivery_ticket_events_append_only before update or delete on public.delivery_ticket_events
  for each row execute function private.prevent_modification();
create trigger a_company_guard before update of company_id on public.delivery_tickets
  for each row execute function private.forbid_company_change();
create trigger a_company_guard before update of company_id on public.delivery_ticket_events
  for each row execute function private.forbid_company_change();

-- prevent_modification lets the sample purge delete history of listed tables.
create or replace function private.prevent_modification()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE'
     and current_setting('tlt.sample_purge', true) = 'on'
     and tg_table_name in ('quote_status_events', 'email_deliveries', 'documents', 'order_status_events',
                           'delivery_ticket_events') then
    return old;
  end if;
  raise exception '% rows are append-only and cannot be changed or deleted.', tg_table_name
    using errcode = '42501';
end;
$$;

-- A load that has live (not voided) tickets cannot be canceled — also when
-- its order is canceled. Void the tickets first.
create or replace function private.guard_load_with_tickets()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status = 'canceled' and old.status <> 'canceled' and exists (
    select 1 from public.delivery_tickets
    where load_id = new.id and status not in ('voided', 'superseded')) then
    raise exception 'Load % has delivery tickets. Void them before canceling the load or its order.', new.load_number;
  end if;
  return new;
end;
$$;

create trigger order_loads_guard_tickets before update of status on public.order_loads
  for each row execute function private.guard_load_with_tickets();

alter table public.delivery_tickets enable row level security;
alter table public.delivery_ticket_events enable row level security;

-- Visible on the tickets screens (tickets.view) and with the order (orders.view).
create policy delivery_tickets_read on public.delivery_tickets for select to authenticated
  using (company_id = (select private.current_company_id())
         and ((select private.has_permission('tickets.view')) or (select private.has_permission('orders.view'))));
create policy delivery_ticket_events_read on public.delivery_ticket_events for select to authenticated
  using (company_id = (select private.current_company_id())
         and ((select private.has_permission('tickets.view')) or (select private.has_permission('orders.view'))));

revoke all on public.delivery_tickets, public.delivery_ticket_events from anon, authenticated;
grant select on public.delivery_tickets, public.delivery_ticket_events to authenticated;
grant all on public.delivery_tickets, public.delivery_ticket_events to service_role;

-- -----------------------------------------------------------------------------
-- 3. Validation helpers
-- -----------------------------------------------------------------------------
-- Units counted in whole numbers (mirrored in src/lib/tickets/rules.ts).
create or replace function private.unit_requires_whole(p_code text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_code in ('load', 'each')
$$;

-- Validates a ticket payload for a load and returns everything needed to
-- write a revision: references, snapshot and review reasons. p_except_number
-- excludes the ticket being corrected from duplicate checks. A correction
-- passes the assignment it was recorded against, used when the load has no
-- active assignment any more.
create or replace function private.prepare_ticket(
  p_company uuid,
  p_payload jsonb,
  p_except_number text,
  p_fallback_assignment uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_load       public.order_loads%rowtype;
  v_order      public.orders%rowtype;
  v_assignment public.dispatch_assignments%rowtype;
  v_line       public.order_lines%rowtype;
  v_truck      public.trucks%rowtype;
  v_trailer    public.trailers%rowtype;
  v_driver_id  uuid;
  v_driver     text;
  v_customer   text;
  v_tz         text := private.business_timezone(p_company);
  v_date       date := nullif(p_payload ->> 'delivered_date', '')::date;
  v_time       time := nullif(p_payload ->> 'delivered_time', '')::time;
  v_at         timestamptz;
  v_qty_text   text := trim(coalesce(p_payload ->> 'quantity', ''));
  v_qty        numeric;
  v_unit       text := nullif(trim(coalesce(p_payload ->> 'unit_code', '')), '');
  v_ref        text := private.clean_text(p_payload ->> 'external_reference', 60, 'Ticket reference');
  v_reasons    text[] := '{}';
  v_confirm    boolean := coalesce((p_payload ->> 'confirm_duplicate')::boolean, false);
  v_trailer_id uuid := nullif(p_payload ->> 'trailer_id', '')::uuid;
  v_dupes      text;
begin
  select * into v_load from public.order_loads
  where id = nullif(p_payload ->> 'load_id', '')::uuid and company_id = p_company for update;
  if not found then raise exception 'Load not found.'; end if;
  if v_load.status = 'canceled' then
    raise exception 'Load % is canceled. Tickets can only be entered for planned loads.', v_load.load_number;
  end if;
  select * into v_order from public.orders where id = v_load.order_id;
  if v_order.status not in ('scheduled', 'dispatched', 'in_progress', 'partially_completed', 'completed') then
    raise exception 'Order % is %. Tickets can be entered for scheduled, dispatched, in-progress or completed orders.',
      v_order.order_number, replace(v_order.status::text, '_', ' ');
  end if;
  select * into v_assignment from public.dispatch_assignments where load_id = v_load.id and status = 'active';
  if not found and p_fallback_assignment is not null then
    select * into v_assignment from public.dispatch_assignments
    where id = p_fallback_assignment and load_id = v_load.id and company_id = p_company;
  end if;
  if not found then
    raise exception '% load % has no truck and driver assigned. Assign it on the dispatch board first.',
      v_order.order_number, v_load.load_number;
  end if;

  -- Order line delivered (gives the material); must be a per-unit line of this order.
  select * into v_line from public.order_lines
  where id = nullif(p_payload ->> 'order_line_id', '')::uuid and company_id = p_company and order_id = v_order.id;
  if not found then raise exception 'Choose the order line that was delivered.'; end if;
  if v_line.calc_method <> 'per_unit' or v_line.kind = 'discount' then
    raise exception 'Choose a material or hauling line measured in units.';
  end if;

  -- Actual quantity and unit: required, never defaulted, never converted.
  if v_qty_text = '' then raise exception 'Enter the delivered quantity.'; end if;
  if v_qty_text !~ '^\d{1,6}(\.\d{1,3})?$' then
    raise exception 'Delivered quantity must be a number greater than 0 with at most 3 decimal places.';
  end if;
  v_qty := v_qty_text::numeric;
  if v_qty <= 0 then raise exception 'Delivered quantity must be greater than 0.'; end if;
  if v_unit is null then raise exception 'Choose the unit of the delivered quantity.'; end if;
  if not exists (select 1 from public.units_of_measure where company_id = p_company and code = v_unit) then
    raise exception 'Choose a valid unit.';
  end if;
  if private.unit_requires_whole(v_unit) and v_qty <> trunc(v_qty) then
    raise exception 'Quantities in % must be whole numbers.', v_unit;
  end if;

  -- Delivery time (local business time).
  if v_date is null or v_time is null then raise exception 'Enter the delivery date and time.'; end if;
  v_at := (v_date + v_time) at time zone v_tz;
  if v_at > now() + interval '1 hour' then raise exception 'The delivery time cannot be in the future.'; end if;
  if v_at < now() - interval '1 year' then raise exception 'The delivery time is more than a year ago.'; end if;

  -- Equipment and driver: from the assignment unless the paper ticket shows otherwise.
  select * into v_truck from public.trucks
  where id = coalesce(nullif(p_payload ->> 'truck_id', '')::uuid, v_assignment.truck_id) and company_id = p_company;
  if not found then raise exception 'Truck not found.'; end if;
  if p_payload ? 'trailer_id' then
    if v_trailer_id is not null then
      select * into v_trailer from public.trailers where id = v_trailer_id and company_id = p_company;
      if not found then raise exception 'Trailer not found.'; end if;
    end if;
  else
    v_trailer_id := v_assignment.trailer_id;
    if v_trailer_id is not null then
      select * into v_trailer from public.trailers where id = v_trailer_id;
    end if;
  end if;
  v_driver_id := coalesce(nullif(p_payload ->> 'driver_id', '')::uuid, v_assignment.driver_id);
  select coalesce(nullif(trim(p.full_name), ''), nullif(d.name, ''), 'Unnamed driver') into v_driver
  from public.drivers d left join public.profiles p on p.id = d.user_id
  where d.id = v_driver_id and d.company_id = p_company;
  if v_driver is null then raise exception 'Driver not found.'; end if;
  select name into v_customer from public.customers where id = v_order.customer_id;

  -- Review reasons (never conversions; the office decides).
  if v_line.unit_code is distinct from v_unit then
    v_reasons := v_reasons || 'unit_differs_from_order_line'::text;
  end if;
  if (v_at at time zone v_tz)::date <> v_load.load_date then
    v_reasons := v_reasons || 'delivered_on_other_day'::text;
  end if;
  if (v_truck.id, v_trailer_id, v_driver_id) is distinct from
     (v_assignment.truck_id, v_assignment.trailer_id, v_assignment.driver_id) then
    v_reasons := v_reasons || 'equipment_differs_from_assignment'::text;
  end if;
  if v_ref = '' then
    v_reasons := v_reasons || 'missing_external_reference'::text;
  end if;

  -- Possible duplicates need an explicit confirmation and are flagged.
  select string_agg(ticket_number, ', ' order by ticket_number) into v_dupes
  from public.delivery_tickets
  where company_id = p_company and load_id = v_load.id and status not in ('voided', 'superseded')
    and ticket_number is distinct from p_except_number;
  if v_dupes is not null then
    if not v_confirm then
      raise exception '% load % already has ticket %. Confirm that this is a separate delivery to add another.',
        v_order.order_number, v_load.load_number, v_dupes using errcode = 'PT422';
    end if;
    v_reasons := v_reasons || 'additional_ticket_for_load'::text;
  end if;
  if v_ref <> '' then
    select string_agg(ticket_number, ', ' order by ticket_number) into v_dupes
    from public.delivery_tickets
    where company_id = p_company and lower(external_reference) = lower(v_ref)
      and status not in ('voided', 'superseded') and ticket_number is distinct from p_except_number;
    if v_dupes is not null then
      if not v_confirm then
        raise exception 'Ticket reference % is already used on %. Confirm to record it again.', v_ref, v_dupes
          using errcode = 'PT422';
      end if;
      v_reasons := v_reasons || 'duplicate_external_reference'::text;
    end if;
  end if;

  return jsonb_build_object(
    'order_id', v_order.id,
    'order_number', v_order.order_number,
    'load_id', v_load.id,
    'assignment_id', v_assignment.id,
    'order_line_id', v_line.id,
    'material_id', v_line.material_id,
    'truck_id', v_truck.id,
    'trailer_id', v_trailer_id,
    'driver_id', v_driver_id,
    'delivered_at', v_at,
    'quantity', v_qty,
    'unit_code', v_unit,
    'external_reference', v_ref,
    'notes', private.clean_text(p_payload ->> 'notes', 2000, 'Notes'),
    'review_reasons', to_jsonb(v_reasons),
    'snapshot', jsonb_build_object(
      'order_number', v_order.order_number,
      'load_number', v_load.load_number,
      'load_date', v_load.load_date,
      'customer_name', v_customer,
      'line_description', v_line.description,
      'line_unit_code', v_line.unit_code,
      'truck_unit', v_truck.unit_number,
      'trailer_unit', v_trailer.unit_number,
      'driver_name', v_driver,
      'planned_quantity', v_load.planned_quantity,
      'planned_unit_code', v_load.unit_code));
end;
$$;

-- -----------------------------------------------------------------------------
-- 4. Submit, correct, review
-- -----------------------------------------------------------------------------
-- Payload: load_id, order_line_id, delivered_date, delivered_time, quantity,
-- unit_code, external_reference, notes, truck_id/trailer_id/driver_id
-- (optional; default from the assignment), submission_key, confirm_duplicate.
create or replace function public.submit_delivery_ticket(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid;
  v_key     uuid := nullif(p_payload ->> 'submission_key', '')::uuid;
  v_t       public.delivery_tickets%rowtype;
  v_p       jsonb;
  v_status  public.ticket_status;
begin
  perform private.require_permission('tickets.edit');
  v_company := private.require_company();

  if v_key is not null then
    select * into v_t from public.delivery_tickets where company_id = v_company and submission_key = v_key;
    if found then
      return jsonb_build_object('ticket_id', v_t.id, 'ticket_number', v_t.ticket_number, 'status', v_t.status, 'created', false);
    end if;
  end if;

  v_p := private.prepare_ticket(v_company, p_payload, null);
  v_status := case when jsonb_array_length(v_p -> 'review_reasons') > 0 then 'needs_review' else 'submitted' end;

  insert into public.delivery_tickets (
    company_id, ticket_number, revision, status, order_id, load_id, assignment_id, order_line_id, material_id,
    truck_id, trailer_id, driver_id, delivered_at, quantity, unit_code, external_reference, notes, review_reasons,
    snapshot, submission_key, created_by)
  values (
    v_company, private.next_document_number(v_company, 'ticket'), 1, v_status,
    (v_p ->> 'order_id')::uuid, (v_p ->> 'load_id')::uuid, (v_p ->> 'assignment_id')::uuid,
    (v_p ->> 'order_line_id')::uuid, nullif(v_p ->> 'material_id', '')::uuid,
    (v_p ->> 'truck_id')::uuid, nullif(v_p ->> 'trailer_id', '')::uuid, (v_p ->> 'driver_id')::uuid,
    (v_p ->> 'delivered_at')::timestamptz, (v_p ->> 'quantity')::numeric, v_p ->> 'unit_code',
    v_p ->> 'external_reference', v_p ->> 'notes',
    array(select jsonb_array_elements_text(v_p -> 'review_reasons')), v_p -> 'snapshot', v_key, auth.uid())
  returning * into v_t;

  insert into public.delivery_ticket_events (company_id, ticket_id, ticket_number, action, from_status, to_status, note, details, actor_id)
  values (v_company, v_t.id, v_t.ticket_number, 'submitted', null, v_t.status, '',
          jsonb_build_object('review_reasons', to_jsonb(v_t.review_reasons)), auth.uid());
  perform private.log_event('ticket.submitted', 'order', v_t.order_id,
    format('Ticket %s for %s load %s: %s %s%s', v_t.ticket_number, v_p -> 'snapshot' ->> 'order_number',
           v_p -> 'snapshot' ->> 'load_number', trim_scale(v_t.quantity), v_t.unit_code,
           case when v_t.status = 'needs_review' then ' (needs review)' else '' end),
    jsonb_build_object('ticket_id', v_t.id, 'ticket_number', v_t.ticket_number, 'load_id', v_t.load_id));

  return jsonb_build_object('ticket_id', v_t.id, 'ticket_number', v_t.ticket_number, 'status', v_t.status, 'created', true);
end;
$$;

-- Correct a ticket: inserts the next revision (same number) and supersedes the
-- current one. Correcting an accepted ticket needs tickets.review.
create or replace function public.correct_delivery_ticket(p_ticket_id uuid, p_payload jsonb, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid;
  v_old     public.delivery_tickets%rowtype;
  v_new     public.delivery_tickets%rowtype;
  v_p       jsonb;
  v_reason  text := private.clean_text(p_reason, 500, 'Reason');
  v_status  public.ticket_status;
begin
  perform private.require_permission('tickets.edit');
  v_company := private.require_company();

  select * into v_old from public.delivery_tickets where id = p_ticket_id and company_id = v_company for update;
  if not found then raise exception 'Ticket not found.'; end if;
  if v_old.status in ('voided', 'superseded') then
    raise exception 'Ticket % revision % is %. Only the current revision of a live ticket can be corrected.',
      v_old.ticket_number, v_old.revision, v_old.status;
  end if;
  if v_old.status = 'accepted' and not private.has_permission('tickets.review') then
    raise exception 'Ticket % was accepted. Only a reviewer can correct it.', v_old.ticket_number using errcode = '42501';
  end if;
  if length(v_reason) = 0 then raise exception 'Enter the reason for the correction.'; end if;
  if nullif(p_payload ->> 'load_id', '')::uuid is distinct from v_old.load_id then
    raise exception 'A correction cannot move the ticket to another load. Void it and enter a new ticket.';
  end if;

  v_p := private.prepare_ticket(v_company, p_payload, v_old.ticket_number, v_old.assignment_id);
  -- A correction is always reviewed again.
  v_status := case when jsonb_array_length(v_p -> 'review_reasons') > 0 then 'needs_review' else 'submitted' end;

  update public.delivery_tickets set status = 'superseded' where id = v_old.id;
  insert into public.delivery_tickets (
    company_id, ticket_number, revision, supersedes_id, status, order_id, load_id, assignment_id, order_line_id,
    material_id, truck_id, trailer_id, driver_id, delivered_at, quantity, unit_code, external_reference, notes,
    review_reasons, snapshot, correction_reason, created_by)
  values (
    v_company, v_old.ticket_number, v_old.revision + 1, v_old.id, v_status,
    v_old.order_id, v_old.load_id, (v_p ->> 'assignment_id')::uuid, (v_p ->> 'order_line_id')::uuid,
    nullif(v_p ->> 'material_id', '')::uuid, (v_p ->> 'truck_id')::uuid, nullif(v_p ->> 'trailer_id', '')::uuid,
    (v_p ->> 'driver_id')::uuid, (v_p ->> 'delivered_at')::timestamptz, (v_p ->> 'quantity')::numeric,
    v_p ->> 'unit_code', v_p ->> 'external_reference', v_p ->> 'notes',
    array(select jsonb_array_elements_text(v_p -> 'review_reasons')), v_p -> 'snapshot', v_reason, auth.uid())
  returning * into v_new;

  insert into public.delivery_ticket_events (company_id, ticket_id, ticket_number, action, from_status, to_status, note, details, actor_id)
  values (v_company, v_new.id, v_new.ticket_number, 'corrected', v_old.status, v_new.status, v_reason,
          jsonb_build_object('previous_revision', v_old.revision, 'revision', v_new.revision,
                             'changes', private.jsonb_changes(to_jsonb(v_old), to_jsonb(v_new),
                               array['quantity', 'unit_code', 'delivered_at', 'external_reference', 'order_line_id',
                                     'truck_id', 'trailer_id', 'driver_id', 'notes'])),
          auth.uid());
  perform private.log_event('ticket.corrected', 'order', v_new.order_id,
    format('Ticket %s corrected (revision %s): %s', v_new.ticket_number, v_new.revision, v_reason),
    jsonb_build_object('ticket_id', v_new.id, 'ticket_number', v_new.ticket_number, 'revision', v_new.revision));

  return jsonb_build_object('ticket_id', v_new.id, 'ticket_number', v_new.ticket_number, 'revision', v_new.revision, 'status', v_new.status);
end;
$$;

-- Accept, flag for review, or void the current revision.
create or replace function public.review_delivery_ticket(p_ticket_id uuid, p_action text, p_note text default '')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid;
  v_t       public.delivery_tickets%rowtype;
  v_note    text := private.clean_text(p_note, 500, 'Note');
  v_to      public.ticket_status;
begin
  perform private.require_permission('tickets.review');
  v_company := private.require_company();
  select * into v_t from public.delivery_tickets where id = p_ticket_id and company_id = v_company for update;
  if not found then raise exception 'Ticket not found.'; end if;

  v_to := case p_action when 'accept' then 'accepted' when 'flag' then 'needs_review' when 'void' then 'voided' end;
  if v_to is null then raise exception 'Unknown review action.'; end if;
  if v_t.status in ('voided', 'superseded') then
    raise exception 'Ticket % revision % is % and cannot be changed.', v_t.ticket_number, v_t.revision, v_t.status;
  end if;
  if v_t.status = v_to then
    raise exception 'Ticket % is already %.', v_t.ticket_number, replace(v_to::text, '_', ' ');
  end if;
  if p_action in ('flag', 'void') and length(v_note) = 0 then
    raise exception 'Enter a reason.';
  end if;

  update public.delivery_tickets set
    status      = v_to,
    reviewed_by = case when p_action <> 'void' then auth.uid() else reviewed_by end,
    reviewed_at = case when p_action <> 'void' then now() else reviewed_at end,
    review_note = case when p_action <> 'void' then v_note else review_note end,
    voided_by   = case when p_action = 'void' then auth.uid() end,
    voided_at   = case when p_action = 'void' then now() end,
    void_reason = case when p_action = 'void' then v_note else '' end
  where id = v_t.id;

  insert into public.delivery_ticket_events (company_id, ticket_id, ticket_number, action, from_status, to_status, note, actor_id)
  values (v_company, v_t.id, v_t.ticket_number,
          case p_action when 'accept' then 'accepted' when 'flag' then 'flagged' else 'voided' end,
          v_t.status, v_to, v_note, auth.uid());
  perform private.log_event('ticket.' || case p_action when 'accept' then 'accepted' when 'flag' then 'flagged' else 'voided' end,
    'order', v_t.order_id,
    format('Ticket %s %s%s', v_t.ticket_number,
           case p_action when 'accept' then 'accepted' when 'flag' then 'flagged for review' else 'voided' end,
           case when length(v_note) > 0 then ': ' || v_note else '' end),
    jsonb_build_object('ticket_id', v_t.id, 'ticket_number', v_t.ticket_number));

  return jsonb_build_object('ticket_id', v_t.id, 'status', v_to);
end;
$$;

-- -----------------------------------------------------------------------------
-- 5. Grants
-- -----------------------------------------------------------------------------
revoke execute on function
  public.submit_delivery_ticket(jsonb),
  public.correct_delivery_ticket(uuid, jsonb, text),
  public.review_delivery_ticket(uuid, text, text)
from public, anon;
grant execute on function
  public.submit_delivery_ticket(jsonb),
  public.correct_delivery_ticket(uuid, jsonb, text),
  public.review_delivery_ticket(uuid, text, text)
to authenticated;

revoke execute on function
  private.guard_delivery_ticket(),
  private.guard_load_with_tickets(),
  private.unit_requires_whole(text),
  private.prepare_ticket(uuid, jsonb, text, uuid)
from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 6. Verification
-- -----------------------------------------------------------------------------
do $$
begin
  if (select count(*) from public.role_permissions where permission = 'tickets.view')
     <> 3 * (select count(*) from public.companies) then
    raise exception 'tickets.view was not granted to owner, office and dispatcher in every company';
  end if;
  if exists (select 1 from public.document_sequences s right join public.companies c
             on c.id = s.company_id and s.key = 'ticket' where s.company_id is null) then
    raise exception 'A company has no ticket number sequence';
  end if;
end;
$$;
