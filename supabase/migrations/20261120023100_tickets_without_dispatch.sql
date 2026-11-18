-- =============================================================================
-- Tickets without Dispatch (owner decision 2026-11-16, master plan MOD1 (2); design: docs/MODULES.md §5).
--
-- With the Dispatch module switched off, a delivery ticket is entered against the customer's job (an order with the
-- material and agreed prices) with ticket number, date, quantity and a photo; truck and driver are optional. Billing
-- prices come from the job, as today.
--
-- How it stays safe for everything that exists:
--   * The delivery is recorded as its own load on the job (order_loads.from_ticket), so billing readiness, the order's
--     progress, the customer portal and reports, which are all load-based, keep working unchanged. Such a load can
--     never be assigned, never takes a dispatched ticket, and is canceled when its ticket is voided.
--   * delivery_tickets.without_dispatch marks the ticket. Only such a ticket may leave assignment, truck and driver
--     empty (check constraint): every ticket of a company that dispatches keeps every existing rule. A new one is
--     written only by submit_ticket_without_dispatch, and the database refuses it while the company has Dispatch on.
--   * Payroll pays tickets with a driver only (unchanged query): a ticket without a driver is simply not payable.
--   * Credit holds (B128, financial review L2) apply as with Dispatch on, where every delivery for a customer on hold
--     goes through assign_load: submit_ticket_without_dispatch and create_ticket_job refuse a customer on hold without
--     a reason of at least 3 characters (payload credit_reason; hint 'credit_hold'), and with one they write the
--     credit_hold_overrides row (context 'order', the job) and the customer.credit_override audit event themselves,
--     in the same transaction. A new job for a customer on hold also needs orders.edit, as for any new order.
--     The profit report groups such a ticket by its own load (no truck time to cost).
--
-- Functions and who may call them:
--   public.submit_ticket_without_dispatch(jsonb)  tickets.edit, own company, Dispatch off (Tickets and Orders on);
--                                                 a reason for a customer on credit hold
--   public.create_ticket_job(jsonb)               tickets.edit plus the order permissions of save_order_draft,
--                                                 update_order_schedule and set_order_status (one transaction); for a
--                                                 customer on credit hold, orders.edit and a reason
--   public.correct_delivery_ticket (replaced)     unchanged rules; a ticket entered without dispatch is rechecked the
--                                                 same way as at entry and keeps its own load
--   public.report_profit (replaced)               unchanged permission; groups a ticket without an assignment by load
--   private.* helpers and triggers                not callable by anyone
-- Additive (columns; constraints relaxed only for marked tickets). Rollback:
-- supabase/rollbacks/20261120023100_tickets_without_dispatch.down.sql
-- =============================================================================

-- 1. Deliveries recorded from a ticket -----------------------------------------------------------------------------
alter table public.order_loads add column if not exists from_ticket boolean not null default false;
comment on column public.order_loads.from_ticket is
  'A delivery recorded from its ticket while the company had Dispatch off (MOD1). Never planned on the board or assigned.';

create or replace function private.guard_ticket_load()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.from_ticket is distinct from old.from_ticket then
    raise exception 'A delivery entered from its ticket stays one.' using errcode = '42501';
  end if;
  return new;
end;
$$;
drop trigger if exists b_ticket_load_guard on public.order_loads;
create trigger b_ticket_load_guard before update of from_ticket on public.order_loads
  for each row execute function private.guard_ticket_load();

create or replace function private.refuse_assignment_on_ticket_load()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from public.order_loads l where l.id = new.load_id and l.company_id = new.company_id and l.from_ticket) then
    raise exception 'This delivery was entered from its ticket without dispatch. It is not planned on the board and cannot get a truck.'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function private.refuse_assignment_on_ticket_load() from public, anon, authenticated;
drop trigger if exists b_no_assignment_on_ticket_load on public.dispatch_assignments;
create trigger b_no_assignment_on_ticket_load before insert on public.dispatch_assignments
  for each row execute function private.refuse_assignment_on_ticket_load();

-- 2. Tickets entered without dispatch ------------------------------------------------------------------------------
alter table public.delivery_tickets add column if not exists without_dispatch boolean not null default false;
comment on column public.delivery_tickets.without_dispatch is
  'Entered against the job while the company had Dispatch off (MOD1): no assignment; truck and driver optional.';
alter table public.delivery_tickets alter column assignment_id drop not null;
alter table public.delivery_tickets alter column truck_id drop not null;
alter table public.delivery_tickets alter column driver_id drop not null;
alter table public.delivery_tickets drop constraint if exists delivery_tickets_dispatch_refs;
alter table public.delivery_tickets add constraint delivery_tickets_dispatch_refs
  check (without_dispatch or (assignment_id is not null and truck_id is not null and driver_id is not null));
alter table public.delivery_tickets drop constraint if exists delivery_tickets_without_dispatch_unassigned;
alter table public.delivery_tickets add constraint delivery_tickets_without_dispatch_unassigned
  check (not without_dispatch or assignment_id is null);
-- Office scans of such a ticket have no assignment either (the driver's own uploads always do).
alter table public.ticket_attachments alter column assignment_id drop not null;

-- A marked ticket only on its own delivery, a dispatched one never on such a delivery, and a new marked ticket only
-- while the company has Dispatch off (a correction of an earlier one stays possible after Dispatch is switched on).
create or replace function private.check_ticket_dispatch()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_from_ticket boolean;
begin
  select l.from_ticket into v_from_ticket from public.order_loads l
   where l.id = new.load_id and l.company_id = new.company_id and l.order_id = new.order_id;
  if new.without_dispatch then
    if not coalesce(v_from_ticket, false) then
      raise exception 'A ticket entered without dispatch is recorded with its own delivery.' using errcode = '42501';
    end if;
    if new.revision = 1 and private.module_on(new.company_id, 'dispatch') then
      raise exception 'Your company uses Dispatch: enter the ticket from its dispatched load.' using errcode = '42501';
    end if;
  elsif coalesce(v_from_ticket, false) then
    raise exception 'This delivery was entered without dispatch. Correct its ticket instead.' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function private.check_ticket_dispatch() from public, anon, authenticated;
drop trigger if exists b_ticket_dispatch_check on public.delivery_tickets;
create trigger b_ticket_dispatch_check before insert on public.delivery_tickets
  for each row execute function private.check_ticket_dispatch();

-- Voiding the ticket cancels its own delivery, so billing never waits for a ticket that will not come.
create or replace function private.ticket_load_on_void()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'voided' and old.status is distinct from 'voided' and new.without_dispatch
     and not exists (select 1 from public.delivery_tickets t
                     where t.load_id = new.load_id and t.company_id = new.company_id and t.id <> new.id
                       and t.status not in ('voided', 'superseded')) then
    update public.order_loads
       set status = 'canceled', cancel_reason = 'Its ticket was voided', canceled_at = now(), canceled_by = auth.uid(),
           updated_at = now(), updated_by = auth.uid()
     where id = new.load_id and company_id = new.company_id and from_ticket and status = 'planned';
  end if;
  return new;
end;
$$;
revoke all on function private.ticket_load_on_void() from public, anon, authenticated;
drop trigger if exists z_ticket_load_on_void on public.delivery_tickets;
create trigger z_ticket_load_on_void after update of status on public.delivery_tickets
  for each row execute function private.ticket_load_on_void();

-- The delivery follows a corrected date.
create or replace function private.ticket_load_follow(p_load uuid, p_at timestamptz)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid;
  v_tz      text;
  v_date    date;
begin
  select company_id into v_company from public.order_loads where id = p_load and from_ticket;
  if not found then return; end if;
  v_tz := private.business_timezone(v_company);
  v_date := (p_at at time zone v_tz)::date;
  update public.order_loads
     set load_date = v_date, starts_at = (v_date + time '00:00') at time zone v_tz, ends_at = (v_date + time '00:01') at time zone v_tz,
         updated_at = now(), updated_by = auth.uid()
   where id = p_load and load_date is distinct from v_date;
end;
$$;
revoke all on function private.ticket_load_follow(uuid, timestamptz) from public, anon, authenticated;

-- Checks for a ticket entered against the job (the same rules as private.prepare_ticket where they apply).
create or replace function private.prepare_ticket_without_dispatch(p_company uuid, p_payload jsonb, p_except_number text, p_load uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order      public.orders%rowtype;
  v_line       public.order_lines%rowtype;
  v_truck      public.trucks%rowtype;
  v_trailer    public.trailers%rowtype;
  v_truck_id   uuid := nullif(p_payload ->> 'truck_id', '')::uuid;
  v_trailer_id uuid := nullif(p_payload ->> 'trailer_id', '')::uuid;
  v_driver_id  uuid := nullif(p_payload ->> 'driver_id', '')::uuid;
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
  v_dupes      text;
  v_load_no    integer;
begin
  select * into v_order from public.orders
   where id = nullif(p_payload ->> 'order_id', '')::uuid and company_id = p_company for update;
  if not found then raise exception 'Choose the customer''s job.'; end if;
  if v_order.status not in ('scheduled', 'dispatched', 'in_progress', 'partially_completed', 'completed') then
    raise exception 'Job % is %. Tickets can be entered for jobs that are scheduled, in progress or completed.',
      v_order.order_number, replace(v_order.status::text, '_', ' ');
  end if;

  select * into v_line from public.order_lines
   where id = nullif(p_payload ->> 'order_line_id', '')::uuid and company_id = p_company and order_id = v_order.id;
  if not found then raise exception 'Choose the material that was delivered.'; end if;
  if v_line.calc_method <> 'per_unit' or v_line.kind = 'discount' then
    raise exception 'Choose a material or hauling line measured in units.';
  end if;

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

  -- Date required; the time only when the ticket shows one (stored at midday, or now for today, and marked).
  if v_date is null then raise exception 'Enter the delivery date.'; end if;
  if v_time is not null then
    v_at := (v_date + v_time) at time zone v_tz;
  elsif v_date = (now() at time zone v_tz)::date then
    v_at := now();
  else
    v_at := (v_date + time '12:00') at time zone v_tz;
  end if;
  if v_at > now() + interval '1 hour' then raise exception 'The delivery date cannot be in the future.'; end if;
  if v_at < now() - interval '1 year' then raise exception 'The delivery date is more than a year ago.'; end if;

  if v_truck_id is not null then
    select * into v_truck from public.trucks where id = v_truck_id and company_id = p_company;
    if not found then raise exception 'Truck not found.'; end if;
  end if;
  if v_trailer_id is not null then
    select * into v_trailer from public.trailers where id = v_trailer_id and company_id = p_company;
    if not found then raise exception 'Trailer not found.'; end if;
  end if;
  if v_driver_id is not null then
    select coalesce(nullif(trim(p.full_name), ''), nullif(d.name, ''), 'Unnamed driver') into v_driver
      from public.drivers d left join public.profiles p on p.id = d.user_id
     where d.id = v_driver_id and d.company_id = p_company;
    if v_driver is null then raise exception 'Driver not found.'; end if;
  end if;
  select name into v_customer from public.customers where id = v_order.customer_id;

  if v_line.unit_code is distinct from v_unit then
    v_reasons := v_reasons || 'unit_differs_from_order_line'::text;
  end if;
  if v_ref = '' and coalesce((select s.ticket_reference_required from public.company_settings s where s.company_id = p_company), true) then
    v_reasons := v_reasons || 'missing_external_reference'::text;
  end if;
  if v_ref <> '' then
    select string_agg(ticket_number, ', ' order by ticket_number) into v_dupes
      from public.delivery_tickets
     where company_id = p_company and lower(external_reference) = lower(v_ref)
       and status not in ('voided', 'superseded') and ticket_number is distinct from p_except_number;
    if v_dupes is not null then
      if not v_confirm then
        raise exception 'Ticket number % is already used on %. Confirm to record it again.', v_ref, v_dupes using errcode = 'PT422';
      end if;
      v_reasons := v_reasons || 'duplicate_external_reference'::text;
    end if;
  end if;

  if p_load is not null then
    select load_number into v_load_no from public.order_loads where id = p_load and company_id = p_company;
  end if;

  return jsonb_build_object(
    'order_id', v_order.id,
    'order_number', v_order.order_number,
    'assignment_id', null,
    'order_line_id', v_line.id,
    'material_id', v_line.material_id,
    'truck_id', v_truck_id,
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
      'load_number', v_load_no,
      'load_date', (v_at at time zone v_tz)::date,
      'customer_name', v_customer,
      'line_description', v_line.description,
      'line_unit_code', v_line.unit_code,
      'truck_unit', v_truck.unit_number,
      'trailer_unit', v_trailer.unit_number,
      'driver_name', v_driver,
      'planned_quantity', null,
      'planned_unit_code', null,
      'without_dispatch', true,
      'time_entered', v_time is not null));
end;
$$;
revoke all on function private.prepare_ticket_without_dispatch(uuid, jsonb, text, uuid) from public, anon, authenticated;

create or replace function public.submit_ticket_without_dispatch(p_payload jsonb)
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
  v_load    public.order_loads%rowtype;
  v_no      integer;
  v_tz      text;
  v_date    date;
  v_customer uuid;
  v_hold    text[];
  v_reason  text := private.clean_text(coalesce(p_payload ->> 'credit_reason', ''), 500, 'Reason');
begin
  perform private.require_permission('tickets.edit');
  v_company := private.require_company();
  if v_key is not null then
    select * into v_t from public.delivery_tickets where company_id = v_company and submission_key = v_key;
    if found then
      return jsonb_build_object('ticket_id', v_t.id, 'ticket_number', v_t.ticket_number, 'status', v_t.status, 'created', false, 'load_id', v_t.load_id);
    end if;
  end if;
  if private.module_on(v_company, 'dispatch') then
    raise exception 'Your company uses Dispatch: enter the ticket from its dispatched load.' using errcode = '42501';
  end if;
  if not private.module_on(v_company, 'tickets') or not private.module_on(v_company, 'orders') then
    raise exception 'Delivery tickets are switched off for your company. The owner can switch them on in Settings.' using errcode = '42501';
  end if;
  -- Credit hold (B128, financial review L2), as assign_load does for every dispatched delivery: going ahead for a
  -- customer on hold needs a reason, recorded with the ticket below.
  select o.customer_id into v_customer from public.orders o
   where o.id = nullif(p_payload ->> 'order_id', '')::uuid and o.company_id = v_company;
  select h.reasons into v_hold from private.credit_holds(v_company, array[v_customer]) h;
  if v_hold is not null and length(v_reason) < 3 then
    raise exception '% is on credit hold. To go ahead, give a reason; it is recorded.',
      coalesce((select c.name from public.customers c where c.id = v_customer and c.company_id = v_company), 'This customer')
      using errcode = '22023', hint = 'credit_hold';
  end if;

  v_p := private.prepare_ticket_without_dispatch(v_company, p_payload, null, null);
  v_tz := private.business_timezone(v_company);
  v_date := ((v_p ->> 'delivered_at')::timestamptz at time zone v_tz)::date;
  -- The job row is locked by the preparation, so load numbers are handed out one at a time.
  select coalesce(max(load_number), 0) + 1 into v_no from public.order_loads
   where order_id = (v_p ->> 'order_id')::uuid and company_id = v_company;
  insert into public.order_loads (company_id, order_id, load_number, load_date, start_time, end_time, starts_at, ends_at,
                                  status, created_by, updated_by, from_ticket)
  values (v_company, (v_p ->> 'order_id')::uuid, v_no, v_date, time '00:00', time '00:01',
          (v_date + time '00:00') at time zone v_tz, (v_date + time '00:01') at time zone v_tz,
          'planned', auth.uid(), auth.uid(), true)
  returning * into v_load;
  v_p := jsonb_set(v_p, '{snapshot,load_number}', to_jsonb(v_no));
  v_status := case when jsonb_array_length(v_p -> 'review_reasons') > 0 then 'needs_review' else 'submitted' end;

  insert into public.delivery_tickets (
    company_id, ticket_number, revision, status, order_id, load_id, assignment_id, order_line_id, material_id,
    truck_id, trailer_id, driver_id, delivered_at, quantity, unit_code, external_reference, notes, review_reasons,
    snapshot, submission_key, created_by, without_dispatch)
  values (
    v_company, private.next_document_number(v_company, 'ticket'), 1, v_status,
    (v_p ->> 'order_id')::uuid, v_load.id, null, (v_p ->> 'order_line_id')::uuid, nullif(v_p ->> 'material_id', '')::uuid,
    nullif(v_p ->> 'truck_id', '')::uuid, nullif(v_p ->> 'trailer_id', '')::uuid, nullif(v_p ->> 'driver_id', '')::uuid,
    (v_p ->> 'delivered_at')::timestamptz, (v_p ->> 'quantity')::numeric, v_p ->> 'unit_code',
    v_p ->> 'external_reference', v_p ->> 'notes',
    array(select jsonb_array_elements_text(v_p -> 'review_reasons')), v_p -> 'snapshot', v_key, auth.uid(), true)
  returning * into v_t;

  insert into public.delivery_ticket_events (company_id, ticket_id, ticket_number, action, from_status, to_status, note, details, actor_id)
  values (v_company, v_t.id, v_t.ticket_number, 'submitted', null, v_t.status, '',
          jsonb_build_object('review_reasons', to_jsonb(v_t.review_reasons), 'source', 'without_dispatch'), auth.uid());
  perform private.log_event('ticket.submitted', 'order', v_t.order_id,
    format('Ticket %s for %s (entered without dispatch): %s %s%s', v_t.ticket_number, v_p ->> 'order_number',
           trim_scale(v_t.quantity), v_t.unit_code, case when v_t.status = 'needs_review' then ' (needs review)' else '' end),
    jsonb_build_object('ticket_id', v_t.id, 'ticket_number', v_t.ticket_number, 'load_id', v_t.load_id, 'source', 'without_dispatch'));
  if v_hold is not null then
    insert into public.credit_hold_overrides (company_id, customer_id, context, entity_id, reason, hold_reasons, created_by)
    values (v_company, v_customer, 'order', v_t.order_id, v_reason, v_hold, auth.uid());
    perform private.log_event('customer.credit_override', 'customer', v_customer,
      format('Entered ticket %s for a customer on credit hold: %s', v_t.ticket_number, v_reason),
      jsonb_build_object('context', 'order', 'entity_id', v_t.order_id, 'order_id', v_t.order_id, 'ticket_id', v_t.id,
                         'load_id', v_load.id, 'source', 'without_dispatch', 'hold_reasons', v_hold));
  end if;

  return jsonb_build_object('ticket_id', v_t.id, 'ticket_number', v_t.ticket_number, 'status', v_t.status, 'created', true, 'load_id', v_load.id);
end;
$$;
revoke all on function public.submit_ticket_without_dispatch(jsonb) from public, anon;
grant execute on function public.submit_ticket_without_dispatch(jsonb) to authenticated;

-- A new job in one step from the ticket screen, through the order functions themselves (prices, price checks, tax and
-- every order permission apply unchanged), in one transaction. A customer on credit hold needs orders.edit and a
-- reason, recorded here as for a new order (the Orders page records it through record_credit_override).
create or replace function public.create_ticket_job(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid;
  v_date    date := nullif(p_payload ->> 'delivered_date', '')::date;
  v_r       jsonb;
  v_order   uuid;
  v_seq     integer;
  v_line    uuid;
  v_customer uuid := nullif(p_payload ->> 'customer_id', '')::uuid;
  v_hold    text[];
  v_reason  text := private.clean_text(coalesce(p_payload ->> 'credit_reason', ''), 500, 'Reason');
begin
  perform private.require_permission('tickets.edit');
  v_company := private.require_company();
  if private.module_on(v_company, 'dispatch') then
    raise exception 'Your company uses Dispatch: create the order on the Orders page.' using errcode = '42501';
  end if;
  if not private.module_on(v_company, 'tickets') or not private.module_on(v_company, 'orders') then
    raise exception 'Delivery tickets are switched off for your company. The owner can switch them on in Settings.' using errcode = '42501';
  end if;
  -- Credit hold (B128, financial review L2): a new job for a customer on hold needs someone who can change orders and a
  -- reason, recorded with the job below.
  select h.reasons into v_hold from private.credit_holds(v_company, array[v_customer]) h;
  if v_hold is not null then
    if not private.has_permission('orders.edit') then
      raise exception '% is on credit hold. A new job for them needs someone who can change orders: they decide whether to go ahead and record why.',
        coalesce((select c.name from public.customers c where c.id = v_customer and c.company_id = v_company), 'This customer')
        using errcode = '42501';
    end if;
    if length(v_reason) < 3 then
      raise exception '% is on credit hold. To go ahead, give a reason; it is recorded.',
        coalesce((select c.name from public.customers c where c.id = v_customer and c.company_id = v_company), 'This customer')
        using errcode = '22023', hint = 'credit_hold';
    end if;
  end if;
  if v_date is null then raise exception 'Enter the delivery date.'; end if;
  if jsonb_typeof(p_payload -> 'lines') is distinct from 'array' or jsonb_array_length(p_payload -> 'lines') <> 1 then
    raise exception 'A new job starts with one material.';
  end if;
  if length(trim(coalesce(p_payload ->> 'site_label', ''))) = 0 then
    raise exception 'Enter where the job delivers (a site or job name).';
  end if;

  v_r := public.save_order_draft((p_payload - 'delivered_date' - 'order_id' - 'credit_reason') || jsonb_build_object('order_date', v_date));
  v_order := (v_r ->> 'order_id')::uuid;
  perform public.set_order_status(v_order, 'confirmed'::public.order_status, 'Job created from the ticket screen');
  select edit_seq into v_seq from public.orders where id = v_order;
  perform public.update_order_schedule(v_order, v_seq, jsonb_build_object('scheduled_start', v_date));
  perform public.set_order_status(v_order, 'scheduled'::public.order_status, '');
  perform public.set_order_status(v_order, 'in_progress'::public.order_status, 'Deliveries are entered from their tickets');
  select id into v_line from public.order_lines where order_id = v_order and company_id = v_company order by line_no limit 1;
  if v_hold is not null then
    insert into public.credit_hold_overrides (company_id, customer_id, context, entity_id, reason, hold_reasons, created_by)
    values (v_company, v_customer, 'order', v_order, v_reason, v_hold, auth.uid());
    perform private.log_event('customer.credit_override', 'customer', v_customer,
      format('Created job %s for a customer on credit hold: %s', v_r ->> 'order_number', v_reason),
      jsonb_build_object('context', 'order', 'entity_id', v_order, 'order_id', v_order, 'source', 'without_dispatch', 'hold_reasons', v_hold));
  end if;
  return jsonb_build_object('order_id', v_order, 'order_number', v_r ->> 'order_number', 'order_line_id', v_line);
end;
$$;
revoke all on function public.create_ticket_job(jsonb) from public, anon;
grant execute on function public.create_ticket_job(jsonb) to authenticated;

-- 3. Existing functions, extended ----------------------------------------------------------------------------------
-- The ticket guard also keeps the new mark unchanged (otherwise as in 20261120003600).
create or replace function private.guard_delivery_ticket()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  if tg_op = 'DELETE' then
    if current_setting('tlt.sample_purge', true) = 'on' then
      return old;
    end if;
    raise exception 'Delivery tickets cannot be deleted. Void them instead.' using errcode = '42501';
  end if;
  -- Demo speed history: entry and review times alone may move, in a demo, inside public.demo_speed_history().
  if (new.created_at, new.reviewed_at) is distinct from (old.created_at, old.reviewed_at) and private.demo_timing_allowed(old.company_id)
     -- ticket_ref_key is generated (not yet computed in NEW inside a BEFORE trigger), so it is left out of the comparison.
     and (to_jsonb(new) - 'created_at' - 'reviewed_at' - 'ticket_ref_key') = (to_jsonb(old) - 'created_at' - 'reviewed_at' - 'ticket_ref_key') then
    return new;
  end if;
  if (new.ticket_number, new.revision, new.supersedes_id, new.order_id, new.load_id, new.assignment_id,
      new.order_line_id, new.material_id, new.truck_id, new.trailer_id, new.driver_id, new.delivered_at,
      new.quantity, new.unit_code, new.external_reference, new.notes, new.review_reasons, new.snapshot,
      new.correction_reason, new.submission_key, new.created_by, new.created_at, new.without_dispatch)
     is distinct from
     (old.ticket_number, old.revision, old.supersedes_id, old.order_id, old.load_id, old.assignment_id,
      old.order_line_id, old.material_id, old.truck_id, old.trailer_id, old.driver_id, old.delivered_at,
      old.quantity, old.unit_code, old.external_reference, old.notes, old.review_reasons, old.snapshot,
      old.correction_reason, old.submission_key, old.created_by, old.created_at, old.without_dispatch) then
    raise exception 'A submitted ticket cannot be edited. Use a correction.' using errcode = '42501';
  end if;
  if new.status is distinct from old.status and not (
       (old.status in ('submitted', 'needs_review') and new.status in ('accepted', 'needs_review', 'voided', 'superseded'))
    or (old.status = 'accepted' and new.status in ('needs_review', 'voided', 'superseded'))) then
    raise exception 'A % ticket cannot become %.', old.status, new.status using errcode = '42501';
  end if;
  return new;
end;
$function$

;

-- Corrections: a ticket entered without dispatch is rechecked the same way as at entry and keeps its own load.
create or replace function public.correct_delivery_ticket(p_ticket_id uuid, p_payload jsonb, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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

  if v_old.without_dispatch then
    -- Entered without dispatch (MOD1): the same checks as its entry, on its own load, which follows the new date.
    v_p := private.prepare_ticket_without_dispatch(v_company, p_payload || jsonb_build_object('order_id', v_old.order_id), v_old.ticket_number, v_old.load_id);
    perform private.ticket_load_follow(v_old.load_id, (v_p ->> 'delivered_at')::timestamptz);
  else
    v_p := private.prepare_ticket(v_company, p_payload, v_old.ticket_number, v_old.assignment_id);
  end if;
  -- A correction is always reviewed again.
  v_status := case when jsonb_array_length(v_p -> 'review_reasons') > 0 then 'needs_review' else 'submitted' end;

  update public.delivery_tickets set status = 'superseded' where id = v_old.id;
  insert into public.delivery_tickets (
    company_id, ticket_number, revision, supersedes_id, status, order_id, load_id, assignment_id, order_line_id,
    material_id, truck_id, trailer_id, driver_id, delivered_at, quantity, unit_code, external_reference, notes,
    review_reasons, snapshot, correction_reason, created_by, without_dispatch)
  values (
    v_company, v_old.ticket_number, v_old.revision + 1, v_old.id, v_status,
    v_old.order_id, v_old.load_id, nullif(v_p ->> 'assignment_id', '')::uuid, (v_p ->> 'order_line_id')::uuid,
    nullif(v_p ->> 'material_id', '')::uuid, nullif(v_p ->> 'truck_id', '')::uuid, nullif(v_p ->> 'trailer_id', '')::uuid,
    nullif(v_p ->> 'driver_id', '')::uuid, (v_p ->> 'delivered_at')::timestamptz, (v_p ->> 'quantity')::numeric,
    v_p ->> 'unit_code', v_p ->> 'external_reference', v_p ->> 'notes',
    array(select jsonb_array_elements_text(v_p -> 'review_reasons')), v_p -> 'snapshot', v_reason, auth.uid(), v_old.without_dispatch)
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
$function$

;

-- Profit report: a ticket without an assignment is grouped by its own load (no truck time to cost).
create or replace function public.report_profit(p_from date, p_to date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_company uuid := private.require_company();
  v_tz text;
  r public.company_cost_rates%rowtype;
  v_has_rates boolean;
  v_out jsonb;
begin
  perform private.require_permission('billing.view');
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then
    raise exception 'Choose a period of up to one year.' using errcode = '22023';
  end if;
  v_tz := private.business_timezone(v_company);
  select * into r from public.company_cost_rates where company_id = v_company;
  v_has_rates := found and (r.truck_hour_cents is not null or r.driver_hour_cents is not null or r.per_load_cents is not null);

  with tickets as (
    -- A ticket entered without dispatch (MOD1) is its own load: grouped by its load, with no truck time to cost.
    select coalesce(t.assignment_id, t.load_id) as assignment_id, t.order_id, t.truck_id,
           case when t.unit_code = l.unit_code and l.calc_method = 'per_unit' and l.unit_rate_cents > 0
                then round(t.quantity * l.unit_rate_cents)::bigint end as value_cents
      from public.delivery_tickets t
      left join public.order_lines l on l.id = t.order_line_id and l.company_id = v_company
     where t.company_id = v_company and t.status = 'accepted'
       and (t.delivered_at at time zone v_tz)::date between p_from and p_to
  ), loads as (
    select tk.assignment_id, min(tk.order_id::text)::uuid as order_id, min(tk.truck_id::text)::uuid as truck_id,
           sum(tk.value_cents) as revenue_cents, bool_or(tk.value_cents is null) as has_unpriced,
           round(extract(epoch from (a.ends_at - a.starts_at)) / 3600.0, 2) as hours
      from tickets tk
      left join public.dispatch_assignments a on a.id = tk.assignment_id and a.company_id = v_company
     group by tk.assignment_id, a.starts_at, a.ends_at
  ), costed as (
    select l.*, o.customer_id,
           case when v_has_rates and l.hours is not null and l.hours > 0
                then round(l.hours * (coalesce(r.truck_hour_cents, 0) + coalesce(r.driver_hour_cents, 0)) + coalesce(r.per_load_cents, 0))::bigint end as cost_cents
      from loads l
      left join public.orders o on o.id = l.order_id and o.company_id = v_company
  ), complete as (
    select * from costed where revenue_cents is not null and cost_cents is not null
  )
  select jsonb_build_object(
    'from', p_from, 'to', p_to, 'has_rates', v_has_rates,
    'rates', case when v_has_rates then jsonb_build_object('truck_hour_cents', r.truck_hour_cents, 'driver_hour_cents', r.driver_hour_cents, 'per_load_cents', r.per_load_cents) end,
    'loads', (select count(*) from costed),
    'loads_costed', (select count(*) from complete),
    'loads_without_price', (select count(*) from costed where revenue_cents is null),
    'loads_with_unpriced_tickets', (select count(*) from costed where has_unpriced and revenue_cents is not null),
    'loads_without_hours', (select count(*) from costed where hours is null or hours <= 0),
    'revenue_cents', (select coalesce(sum(revenue_cents), 0) from complete),
    'cost_cents', (select coalesce(sum(cost_cents), 0) from complete),
    'hours', (select coalesce(sum(hours), 0) from complete),
    'by_customer', coalesce((select jsonb_agg(x order by x.profit_cents desc) from (
        select coalesce(c.name, 'Unknown customer') as name, count(*) as loads, sum(k.revenue_cents) as revenue_cents, sum(k.cost_cents) as cost_cents,
               sum(k.revenue_cents) - sum(k.cost_cents) as profit_cents
          from complete k left join public.customers c on c.id = k.customer_id and c.company_id = v_company
         group by c.name order by sum(k.revenue_cents) - sum(k.cost_cents) desc limit 15) x), '[]'),
    'by_truck', coalesce((select jsonb_agg(x order by x.profit_cents desc) from (
        select coalesce(tr.unit_number, 'No truck') as name, count(*) as loads, sum(k.revenue_cents) as revenue_cents, sum(k.cost_cents) as cost_cents,
               sum(k.revenue_cents) - sum(k.cost_cents) as profit_cents, sum(k.hours) as hours
          from complete k left join public.trucks tr on tr.id = k.truck_id and tr.company_id = v_company
         group by tr.unit_number order by sum(k.revenue_cents) - sum(k.cost_cents) desc limit 15) x), '[]'))
  into v_out;
  return v_out;
end;
$function$

;

do $$
declare
  f text;
begin
  foreach f in array array['refuse_assignment_on_ticket_load', 'check_ticket_dispatch', 'ticket_load_on_void', 'ticket_load_follow', 'prepare_ticket_without_dispatch'] loop
    if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                   where n.nspname = 'private' and p.proname = f and p.prosecdef and 'search_path=""' = any (p.proconfig)) then
      raise exception 'private.% is not installed as expected', f;
    end if;
  end loop;
end;
$$;

-- Both entry points check and record credit holds themselves (financial review L2), as pinned definer functions.
do $$
declare
  f text;
begin
  foreach f in array array['public.submit_ticket_without_dispatch(jsonb)', 'public.create_ticket_job(jsonb)'] loop
    if position('insert into public.credit_hold_overrides' in pg_get_functiondef(f::regprocedure)) = 0
       or not exists (select 1 from pg_proc p where p.oid = f::regprocedure and p.prosecdef and 'search_path=""' = any (p.proconfig)) then
      raise exception '% does not record credit hold reasons as expected', f;
    end if;
  end loop;
end;
$$;
