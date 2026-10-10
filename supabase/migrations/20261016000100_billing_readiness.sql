-- =============================================================================
-- Ticket reconciliation and billing readiness (N6).
--
-- Design (docs/IMPLEMENTATION_PLAN.md §5e):
--   * Readiness is DERIVED, never stored: the views billing_load_status,
--     billing_line_status, billing_exceptions and billing_order_status compute
--     it from loads, assignments, order lines and the current ticket revisions
--     every time they are read, so it cannot drift from the records.
--   * The only stored decisions are the office's: an acknowledgment of an
--     order's exceptions (billing_reviews, with a reason) and a billing handoff
--     (billing_handoffs + billing_handoff_orders, with actor, time and
--     reference). An acknowledgment is tied to a fingerprint of the exact
--     exceptions it covers and stops counting as soon as they change.
--   * Quantities are compared only in the same, explicitly recorded unit. No
--     conversion, no zero for a missing value, no tolerance: any difference is
--     an exception for the office to acknowledge.
--   * Order prices are never recalculated or changed; nothing here marks an
--     order billed or paid. QuickBooks remains the accounting system.
-- Additive. To reverse: drop the functions, views and triggers defined here,
-- the three billing tables, the billing.* permissions and the 'billing'
-- document sequences.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Permissions and the batch number sequence
-- -----------------------------------------------------------------------------
insert into public.permissions (code, category, description) values
  ('billing.view',   'Billing', 'View billing readiness, exceptions and billing handoffs'),
  ('billing.manage', 'Billing', 'Acknowledge billing exceptions, hand orders off for billing and undo a handoff');

insert into public.role_permission_defaults (role, permission) values
  ('owner', 'billing.view'), ('owner', 'billing.manage'),
  ('office', 'billing.view'), ('office', 'billing.manage');

insert into public.role_permissions (company_id, role, permission)
select c.id, d.role, d.permission
from public.companies c
cross join public.role_permission_defaults d
where d.permission like 'billing.%'
on conflict do nothing;

-- Handoff batch numbers (B-2026-0001), per company like the other documents.
alter table public.document_sequences drop constraint document_sequences_key_check;
alter table public.document_sequences add constraint document_sequences_key_check
  check (key in ('customer', 'quote', 'order', 'ticket', 'billing'));
insert into public.document_sequences (company_id, key, label, prefix, include_year, pad)
select id, 'billing', 'Billing handoff batches', 'B-', true, 4 from public.companies
on conflict do nothing;

-- Companies created later get the sequence too (create_company is unchanged).
create or replace function private.add_billing_sequence()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.document_sequences (company_id, key, label, prefix, include_year, pad)
  values (new.id, 'billing', 'Billing handoff batches', 'B-', true, 4)
  on conflict do nothing;
  return new;
end;
$$;

create trigger companies_billing_sequence after insert on public.companies
  for each row execute function private.add_billing_sequence();

-- -----------------------------------------------------------------------------
-- 2. Office decisions
-- -----------------------------------------------------------------------------
-- An acknowledgment that an order's exceptions (quantity differences, units
-- that cannot be compared, lines without tickets, missing PO, zero rates) were
-- reviewed. Valid only while the order's exception fingerprint is unchanged.
create table public.billing_reviews (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies (id),
  order_id    uuid not null,
  fingerprint text not null,
  exceptions  jsonb not null,
  reason      text not null check (length(trim(reason)) between 1 and 500),
  decided_by  uuid references auth.users (id) on delete set null,
  decided_at  timestamptz not null default now(),
  constraint billing_reviews_order_fk foreign key (company_id, order_id)
    references public.orders (company_id, id) on delete cascade
);
create index billing_reviews_order_idx on public.billing_reviews (company_id, order_id, decided_at desc);

-- A handoff batch: the orders given to the person entering invoices in
-- QuickBooks, with an optional reference (for example their batch name).
create table public.billing_handoffs (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references public.companies (id),
  batch_number     text not null,
  reference        text not null default '' check (length(reference) <= 80),
  notes            text not null default '' check (length(notes) <= 1000),
  submission_key   uuid,
  created_by       uuid references auth.users (id) on delete set null,
  created_at       timestamptz not null default now(),
  export_count     integer not null default 0 check (export_count >= 0),
  last_exported_at timestamptz,
  last_exported_by uuid references auth.users (id) on delete set null,
  unique (company_id, id),
  unique (company_id, batch_number)
);
create unique index billing_handoffs_submission on public.billing_handoffs (company_id, submission_key) where submission_key is not null;

-- One row per order in a batch. The snapshot freezes what was handed off
-- (order, lines, accepted tickets) so the batch file never changes later.
create table public.billing_handoff_orders (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid not null references public.companies (id),
  handoff_id            uuid not null,
  order_id              uuid not null,
  documents_fingerprint text not null,
  snapshot              jsonb not null,
  reverted_at           timestamptz,
  reverted_by           uuid references auth.users (id) on delete set null,
  revert_reason         text not null default '',
  constraint billing_handoff_orders_handoff_fk foreign key (company_id, handoff_id)
    references public.billing_handoffs (company_id, id),
  constraint billing_handoff_orders_order_fk foreign key (company_id, order_id)
    references public.orders (company_id, id) on delete cascade,
  constraint billing_handoff_orders_revert check (
    (reverted_at is null and revert_reason = '') or (reverted_at is not null and length(trim(revert_reason)) > 0))
);
-- An order is in at most one active (not undone) handoff: no double handoff.
create unique index billing_handoff_orders_active on public.billing_handoff_orders (company_id, order_id) where reverted_at is null;
create index billing_handoff_orders_handoff_idx on public.billing_handoff_orders (handoff_id);

-- Batches change only by recording a download; handoff rows only by being
-- undone once. Nothing is deleted except with a sample order.
create or replace function private.guard_billing_handoff()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if current_setting('tlt.sample_purge', true) = 'on' then
      return old;
    end if;
    raise exception 'Billing handoffs cannot be deleted. Undo the handoff instead.' using errcode = '42501';
  end if;
  if tg_table_name = 'billing_handoffs' then
    if (new.batch_number, new.reference, new.notes, new.submission_key, new.created_by, new.created_at)
       is distinct from (old.batch_number, old.reference, old.notes, old.submission_key, old.created_by, old.created_at)
       or new.export_count < old.export_count then
      raise exception 'A billing handoff batch cannot be changed.' using errcode = '42501';
    end if;
  else
    if (new.handoff_id, new.order_id, new.documents_fingerprint, new.snapshot)
       is distinct from (old.handoff_id, old.order_id, old.documents_fingerprint, old.snapshot)
       or old.reverted_at is not null then
      raise exception 'A billing handoff cannot be changed, only undone once.' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

create trigger billing_handoffs_guard before update or delete on public.billing_handoffs
  for each row execute function private.guard_billing_handoff();
create trigger billing_handoff_orders_guard before update or delete on public.billing_handoff_orders
  for each row execute function private.guard_billing_handoff();
create trigger billing_reviews_append_only before update or delete on public.billing_reviews
  for each row execute function private.prevent_modification();
create trigger a_company_guard before update of company_id on public.billing_reviews
  for each row execute function private.forbid_company_change();
create trigger a_company_guard before update of company_id on public.billing_handoffs
  for each row execute function private.forbid_company_change();
create trigger a_company_guard before update of company_id on public.billing_handoff_orders
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
                           'delivery_ticket_events', 'billing_reviews') then
    return old;
  end if;
  raise exception '% rows are append-only and cannot be changed or deleted.', tg_table_name
    using errcode = '42501';
end;
$$;

alter table public.billing_reviews enable row level security;
alter table public.billing_handoffs enable row level security;
alter table public.billing_handoff_orders enable row level security;

create policy billing_reviews_read on public.billing_reviews for select to authenticated
  using (company_id = (select private.current_company_id()) and (select private.has_permission('billing.view')));
create policy billing_handoffs_read on public.billing_handoffs for select to authenticated
  using (company_id = (select private.current_company_id()) and (select private.has_permission('billing.view')));
create policy billing_handoff_orders_read on public.billing_handoff_orders for select to authenticated
  using (company_id = (select private.current_company_id()) and (select private.has_permission('billing.view')));

revoke all on public.billing_reviews, public.billing_handoffs, public.billing_handoff_orders from anon, authenticated;
grant select on public.billing_reviews, public.billing_handoffs, public.billing_handoff_orders to authenticated;
grant all on public.billing_reviews, public.billing_handoffs, public.billing_handoff_orders to service_role;

-- -----------------------------------------------------------------------------
-- 3. Derived readiness (views; security_invoker so the caller's RLS applies)
-- -----------------------------------------------------------------------------
-- Orders in billing scope: work that has been scheduled or done. Draft,
-- Confirmed (not scheduled), On hold and Canceled orders are out of scope;
-- canceled loads are ignored (a load with live tickets cannot be canceled).
--
-- One row per planned load of an order in scope.
--   documentation_state: missing (due and no live ticket), not_due, needs_review
--   (a live ticket not accepted yet), documented (all live tickets accepted).
--   A load is due once its planned end time has passed, or when its order is
--   Completed. Voided and superseded revisions never count as deliveries.
--   quantity_check (planned vs delivered, same unit only): no_tickets,
--   not_planned, units_differ, match, over, under.
create view public.billing_load_status with (security_invoker = true) as
select
  l.id as load_id,
  l.company_id,
  l.order_id,
  o.order_number,
  o.status as order_status,
  o.customer_id,
  c.name as customer_name,
  l.load_number,
  l.load_date,
  l.start_time,
  l.end_time,
  l.ends_at,
  l.planned_quantity,
  l.unit_code as planned_unit_code,
  a.id as assignment_id,
  a.truck_id,
  a.trailer_id,
  a.driver_id,
  (l.ends_at <= now() or o.status = 'completed') as is_due,
  coalesce(t.live_count, 0)::int as live_count,
  coalesce(t.accepted_count, 0)::int as accepted_count,
  coalesce(t.pending_count, 0)::int as pending_count,
  coalesce(t.other_unit_count, 0)::int as other_unit_count,
  t.delivered_quantity,
  t.ticket_units,
  t.live_numbers,
  t.voided_numbers,
  case
    when coalesce(t.pending_count, 0) > 0 then 'needs_review'
    when coalesce(t.live_count, 0) > 0 then 'documented'
    when l.ends_at <= now() or o.status = 'completed' then 'missing'
    else 'not_due'
  end as documentation_state,
  case
    when coalesce(t.live_count, 0) = 0 then 'no_tickets'
    when l.planned_quantity is null then 'not_planned'
    when t.other_unit_count > 0 then 'units_differ'
    when t.delivered_quantity = l.planned_quantity then 'match'
    when t.delivered_quantity > l.planned_quantity then 'over'
    else 'under'
  end as quantity_check,
  case
    when coalesce(t.live_count, 0) > 0 and l.planned_quantity is not null and t.other_unit_count = 0
      then t.delivered_quantity - l.planned_quantity
  end as quantity_difference
from public.order_loads l
join public.orders o on o.id = l.order_id and o.company_id = l.company_id
left join public.customers c on c.id = o.customer_id and c.company_id = o.company_id
left join public.dispatch_assignments a on a.load_id = l.id and a.company_id = l.company_id and a.status = 'active'
left join lateral (
  select
    count(*) filter (where dt.status in ('submitted', 'needs_review', 'accepted')) as live_count,
    count(*) filter (where dt.status = 'accepted') as accepted_count,
    count(*) filter (where dt.status in ('submitted', 'needs_review')) as pending_count,
    count(*) filter (where dt.status in ('submitted', 'needs_review', 'accepted')
                       and dt.unit_code is distinct from l.unit_code) as other_unit_count,
    sum(dt.quantity) filter (where dt.status in ('submitted', 'needs_review', 'accepted')
                               and dt.unit_code = l.unit_code) as delivered_quantity,
    array_agg(distinct dt.unit_code) filter (where dt.status in ('submitted', 'needs_review', 'accepted')) as ticket_units,
    array_agg(dt.ticket_number order by dt.ticket_number) filter (where dt.status in ('submitted', 'needs_review', 'accepted')) as live_numbers,
    array_agg(dt.ticket_number order by dt.ticket_number) filter (where dt.status = 'voided') as voided_numbers
  from public.delivery_tickets dt
  where dt.load_id = l.id and dt.company_id = l.company_id
) t on true
where l.status = 'planned'
  and o.status in ('scheduled', 'dispatched', 'in_progress', 'partially_completed', 'completed');

-- One row per per-unit order line (not discounts) of an order in scope.
--   quantity_check (ordered vs delivered, same unit only), evaluated once the
--   order is Completed: in_progress, no_tickets, units_differ, match, over,
--   under. pricing_check: ok, zero_rate. Prices are shown, never recalculated.
create view public.billing_line_status with (security_invoker = true) as
select
  ol.id as line_id,
  ol.company_id,
  ol.order_id,
  o.order_number,
  o.status as order_status,
  ol.line_no,
  ol.kind,
  ol.description,
  ol.material_id,
  ol.unit_code,
  ol.quantity as ordered_quantity,
  ol.unit_rate_cents,
  ol.amount_cents,
  ol.price_source,
  coalesce(t.live_count, 0)::int as live_count,
  coalesce(t.pending_count, 0)::int as pending_count,
  coalesce(t.other_unit_count, 0)::int as other_unit_count,
  t.delivered_quantity,
  t.ticket_units,
  case
    when o.status <> 'completed' then 'in_progress'
    when coalesce(t.live_count, 0) = 0 then 'no_tickets'
    when t.other_unit_count > 0 then 'units_differ'
    when t.delivered_quantity = ol.quantity then 'match'
    when t.delivered_quantity > ol.quantity then 'over'
    else 'under'
  end as quantity_check,
  case
    when coalesce(t.live_count, 0) > 0 and t.other_unit_count = 0 then t.delivered_quantity - ol.quantity
  end as quantity_difference,
  case when ol.unit_rate_cents = 0 then 'zero_rate' else 'ok' end as pricing_check
from public.order_lines ol
join public.orders o on o.id = ol.order_id and o.company_id = ol.company_id
left join lateral (
  select
    count(*) as live_count,
    count(*) filter (where dt.status in ('submitted', 'needs_review')) as pending_count,
    count(*) filter (where dt.unit_code is distinct from ol.unit_code) as other_unit_count,
    sum(dt.quantity) filter (where dt.unit_code = ol.unit_code) as delivered_quantity,
    array_agg(distinct dt.unit_code) as ticket_units
  from public.delivery_tickets dt
  where dt.order_line_id = ol.id and dt.company_id = ol.company_id
    and dt.status in ('submitted', 'needs_review', 'accepted')
) t on true
where ol.calc_method = 'per_unit' and ol.kind <> 'discount'
  and o.status in ('scheduled', 'dispatched', 'in_progress', 'partially_completed', 'completed');

-- Exceptions the office must acknowledge before an order is ready. `key`
-- carries the compared values, so any change (a correction, a void, a new
-- ticket) produces a different fingerprint and needs a new acknowledgment.
create view public.billing_exceptions with (security_invoker = true) as
select company_id, order_id, exception_kind as kind, load_id, null::uuid as line_id, load_number, null::int as line_no,
       planned_quantity as expected_quantity, delivered_quantity as actual_quantity,
       planned_unit_code as unit_code, ticket_units, quantity_difference as difference,
       concat_ws(':', 'load', load_id, quantity_check, planned_quantity, planned_unit_code, delivered_quantity,
                 array_to_string(ticket_units, '|')) as key
from (
  select *, case quantity_check when 'units_differ' then 'load_units_differ' else 'load_quantity' end as exception_kind
  from public.billing_load_status
  where quantity_check in ('over', 'under', 'units_differ')
) l
union all
select company_id, order_id, exception_kind, null, line_id, null, line_no,
       ordered_quantity, delivered_quantity, unit_code, ticket_units,
       case when exception_kind = 'line_quantity' then quantity_difference end,
       concat_ws(':', 'line', line_id, exception_kind, ordered_quantity, unit_code, delivered_quantity, unit_rate_cents,
                 array_to_string(ticket_units, '|'))
from (
  select *, 'line_quantity' as exception_kind from public.billing_line_status where quantity_check in ('over', 'under')
  union all
  select *, 'line_units_differ' from public.billing_line_status where quantity_check = 'units_differ'
  union all
  select *, 'line_no_tickets' from public.billing_line_status where quantity_check = 'no_tickets'
  union all
  select *, 'line_zero_rate' from public.billing_line_status where pricing_check = 'zero_rate'
) x
union all
select o.company_id, o.id, 'po_missing', null, null, null, null, null, null, null, null, null,
       concat_ws(':', 'po', o.id)
from public.orders o
join public.customers c on c.id = o.customer_id and c.company_id = o.company_id
where c.po_required and trim(o.customer_po) = ''
  and o.status in ('scheduled', 'dispatched', 'in_progress', 'partially_completed', 'completed');

-- One row per order in scope with its readiness. Precedence (first that
-- applies): handed_off › missing_documentation › needs_review › blocked
-- (unacknowledged exceptions) › in_progress (order not Completed) › ready.
create view public.billing_order_status with (security_invoker = true) as
with loads as (
  select order_id,
         count(*)::int as loads_total,
         count(*) filter (where is_due)::int as loads_due,
         count(*) filter (where documentation_state = 'missing')::int as loads_missing,
         count(*) filter (where documentation_state = 'not_due')::int as loads_not_due,
         min(load_date) as first_load_date,
         max(load_date) as last_load_date
  from public.billing_load_status group by order_id
), tickets as (
  select order_id,
         count(*) filter (where status in ('submitted', 'needs_review', 'accepted'))::int as tickets_live,
         count(*) filter (where status in ('submitted', 'needs_review'))::int as tickets_pending,
         count(*) filter (where status = 'accepted')::int as tickets_accepted,
         md5(string_agg(id::text || ':' || status::text, ',' order by id)) as documents_fingerprint
  from public.delivery_tickets where status <> 'superseded' group by order_id
), exceptions as (
  select order_id, count(*)::int as exceptions_count, md5(string_agg(key, ',' order by key)) as exceptions_fingerprint
  from public.billing_exceptions group by order_id
), base as (
  select o.id as order_id, o.company_id, o.order_number, o.status, o.customer_id, c.name as customer_name,
         c.customer_number, o.project_name, o.customer_po, o.order_date, o.scheduled_start, o.scheduled_end,
         o.completed_at, o.total_cents, o.is_sample,
         coalesce(l.first_load_date, o.scheduled_start) as service_start,
         coalesce(l.last_load_date, o.scheduled_end, o.scheduled_start) as service_end,
         coalesce(l.loads_total, 0) as loads_total, coalesce(l.loads_due, 0) as loads_due,
         coalesce(l.loads_missing, 0) as loads_missing, coalesce(l.loads_not_due, 0) as loads_not_due,
         coalesce(t.tickets_live, 0) as tickets_live, coalesce(t.tickets_pending, 0) as tickets_pending,
         coalesce(t.tickets_accepted, 0) as tickets_accepted,
         coalesce(t.documents_fingerprint, md5('')) as documents_fingerprint,
         coalesce(e.exceptions_count, 0) as exceptions_count,
         coalesce(e.exceptions_fingerprint, md5('')) as exceptions_fingerprint
  from public.orders o
  left join public.customers c on c.id = o.customer_id and c.company_id = o.company_id
  left join loads l on l.order_id = o.id
  left join tickets t on t.order_id = o.id
  left join exceptions e on e.order_id = o.id
  where o.status in ('scheduled', 'dispatched', 'in_progress', 'partially_completed', 'completed')
)
select b.*,
       r.id as acknowledgment_id, r.decided_by as acknowledged_by, r.decided_at as acknowledged_at,
       r.reason as acknowledgment_reason,
       (select max(x.decided_at) from public.billing_reviews x
         where x.order_id = b.order_id and x.company_id = b.company_id) as last_acknowledged_at,
       h.id as handoff_order_id, h.handoff_id, hb.batch_number, hb.reference as handoff_reference,
       hb.created_at as handed_off_at, hb.created_by as handed_off_by,
       (h.id is not null and h.documents_fingerprint <> b.documents_fingerprint) as changed_since_handoff,
       case
         when h.id is not null then 'handed_off'
         when b.loads_missing > 0 or (b.status = 'completed' and b.tickets_live = 0) then 'missing_documentation'
         when b.tickets_pending > 0 then 'needs_review'
         when b.exceptions_count > 0 and r.id is null then 'blocked'
         when b.status <> 'completed' then 'in_progress'
         else 'ready'
       end as readiness
from base b
left join lateral (
  select * from public.billing_reviews x
  where x.order_id = b.order_id and x.company_id = b.company_id and x.fingerprint = b.exceptions_fingerprint
  order by x.decided_at desc limit 1
) r on b.exceptions_count > 0
left join public.billing_handoff_orders h
  on h.order_id = b.order_id and h.company_id = b.company_id and h.reverted_at is null
left join public.billing_handoffs hb on hb.id = h.handoff_id and hb.company_id = h.company_id;

grant select on public.billing_load_status, public.billing_line_status, public.billing_exceptions,
  public.billing_order_status to authenticated, service_role;
revoke all on public.billing_load_status, public.billing_line_status, public.billing_exceptions,
  public.billing_order_status from anon;

-- -----------------------------------------------------------------------------
-- 4. Acknowledge exceptions, hand off, undo, record a download
-- -----------------------------------------------------------------------------
-- The caller passes the fingerprint of the exceptions they reviewed; if the
-- exceptions changed meanwhile the acknowledgment is refused (PT409).
create or replace function public.acknowledge_billing_exceptions(p_order_id uuid, p_fingerprint text, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid;
  v_s       public.billing_order_status%rowtype;
  v_reason  text := private.clean_text(p_reason, 500, 'Reason');
  v_id      uuid;
begin
  perform private.require_permission('billing.manage');
  v_company := private.require_company();
  perform 1 from public.orders where id = p_order_id and company_id = v_company for update;
  if not found then raise exception 'Order not found.'; end if;

  select * into v_s from public.billing_order_status where order_id = p_order_id and company_id = v_company;
  if not found then raise exception 'This order is not in billing review (it is not scheduled or completed).'; end if;
  if v_s.readiness = 'handed_off' then
    raise exception 'Order % was already handed off for billing in batch %.', v_s.order_number, v_s.batch_number;
  end if;
  if v_s.exceptions_count = 0 then raise exception 'Order % has no exceptions to acknowledge.', v_s.order_number; end if;
  if v_s.exceptions_fingerprint is distinct from p_fingerprint then
    raise exception 'The exceptions of order % changed since the page was loaded. Reload and review them again.', v_s.order_number
      using errcode = 'PT409';
  end if;
  if v_s.acknowledgment_id is not null then
    raise exception 'These exceptions of order % are already acknowledged.', v_s.order_number using errcode = 'PT409';
  end if;
  if length(v_reason) = 0 then raise exception 'Enter the reason for accepting these exceptions.'; end if;

  insert into public.billing_reviews (company_id, order_id, fingerprint, exceptions, reason, decided_by)
  values (v_company, p_order_id, v_s.exceptions_fingerprint,
          (select coalesce(jsonb_agg(to_jsonb(e) - 'company_id' - 'key' order by e.key), '[]')
           from public.billing_exceptions e where e.order_id = p_order_id and e.company_id = v_company),
          v_reason, auth.uid())
  returning id into v_id;

  perform private.log_event('billing.exceptions_acknowledged', 'order', p_order_id,
    format('Billing exceptions acknowledged (%s): %s', v_s.exceptions_count, v_reason),
    jsonb_build_object('review_id', v_id, 'exceptions', v_s.exceptions_count));
  return jsonb_build_object('review_id', v_id);
end;
$$;

-- Hand ready orders off for billing as one batch. Rechecks readiness after
-- locking the orders, their loads and tickets, so a concurrent ticket change
-- either finishes first (and is seen) or waits. A repeated submission returns
-- the same batch; an order already in an active handoff is refused.
create or replace function public.hand_off_orders(p_order_ids uuid[], p_reference text, p_notes text, p_submission_key uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company  uuid;
  v_ref      text := private.clean_text(p_reference, 80, 'Reference');
  v_notes    text := private.clean_text(p_notes, 1000, 'Notes');
  v_ids      uuid[];
  v_batch    public.billing_handoffs%rowtype;
  v_s        public.billing_order_status%rowtype;
  v_problems text;
  v_count    integer;
begin
  perform private.require_permission('billing.manage');
  v_company := private.require_company();

  if p_submission_key is not null then
    select * into v_batch from public.billing_handoffs where company_id = v_company and submission_key = p_submission_key;
    if found then
      return jsonb_build_object('handoff_id', v_batch.id, 'batch_number', v_batch.batch_number, 'created', false,
        'orders', (select count(*) from public.billing_handoff_orders where handoff_id = v_batch.id));
    end if;
  end if;

  select array_agg(distinct x order by x) into v_ids from unnest(p_order_ids) x where x is not null;
  if v_ids is null then raise exception 'Choose at least one order to hand off.'; end if;
  if array_length(v_ids, 1) > 200 then raise exception 'Hand off at most 200 orders at a time.'; end if;

  -- Lock in a fixed order: orders, then their loads, then their tickets.
  perform 1 from public.orders where id = any(v_ids) and company_id = v_company order by id for update;
  get diagnostics v_count = row_count;
  if v_count <> array_length(v_ids, 1) then raise exception 'Order not found.'; end if;
  perform 1 from public.order_loads where order_id = any(v_ids) and company_id = v_company order by id for update;
  perform 1 from public.delivery_tickets where order_id = any(v_ids) and company_id = v_company order by id for update;

  select string_agg(format('%s (in batch %s)', order_number, batch_number), ', ' order by order_number) into v_problems
  from public.billing_order_status
  where company_id = v_company and order_id = any(v_ids) and readiness = 'handed_off';
  if v_problems is not null then
    raise exception 'Already handed off for billing: %. Undo that handoff first if it must be repeated.', v_problems
      using errcode = 'PT409';
  end if;

  select string_agg(format('%s (%s)', s.order_number, replace(coalesce(s.readiness, 'not in billing'), '_', ' ')), ', ' order by s.order_number)
  into v_problems
  from unnest(v_ids) i(id)
  left join public.billing_order_status s on s.order_id = i.id and s.company_id = v_company
  where s.readiness is distinct from 'ready';
  if v_problems is not null then
    raise exception 'Only orders that are ready to bill can be handed off. Not ready: %.', v_problems;
  end if;

  insert into public.billing_handoffs (company_id, batch_number, reference, notes, submission_key, created_by)
  values (v_company, private.next_document_number(v_company, 'billing'), v_ref, v_notes, p_submission_key, auth.uid())
  returning * into v_batch;

  for v_s in select * from public.billing_order_status where company_id = v_company and order_id = any(v_ids) order by order_number loop
    insert into public.billing_handoff_orders (company_id, handoff_id, order_id, documents_fingerprint, snapshot)
    select v_company, v_batch.id, v_s.order_id, v_s.documents_fingerprint, jsonb_build_object(
      'order', jsonb_build_object(
        'order_id', v_s.order_id, 'order_number', v_s.order_number, 'customer_number', v_s.customer_number,
        'customer_name', v_s.customer_name, 'project_name', v_s.project_name, 'customer_po', v_s.customer_po,
        'service_start', v_s.service_start, 'service_end', v_s.service_end, 'completed_at', v_s.completed_at,
        'subtotal_cents', o.subtotal_cents, 'discount_cents', o.discount_cents, 'tax_cents', o.tax_cents,
        'total_cents', o.total_cents, 'acknowledgment_reason', v_s.acknowledgment_reason),
      'lines', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'line_id', ol.id, 'line_no', ol.line_no, 'kind', ol.kind, 'calc_method', ol.calc_method,
          'description', ol.description, 'unit_code', ol.unit_code, 'quantity', ol.quantity,
          'unit_rate_cents', ol.unit_rate_cents, 'percent_bp', ol.percent_bp, 'amount_cents', ol.amount_cents,
          'price_source', ol.price_source, 'taxable', ol.taxable,
          'delivered_quantity', ls.delivered_quantity, 'quantity_check', ls.quantity_check) order by ol.line_no), '[]')
        from public.order_lines ol
        left join public.billing_line_status ls on ls.line_id = ol.id
        where ol.order_id = v_s.order_id and ol.company_id = v_company),
      'tickets', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'ticket_id', dt.id, 'ticket_number', dt.ticket_number, 'revision', dt.revision,
          'load_number', dt.snapshot ->> 'load_number', 'order_line_id', dt.order_line_id,
          'delivered_at', dt.delivered_at, 'quantity', dt.quantity, 'unit_code', dt.unit_code,
          'external_reference', dt.external_reference) order by dt.ticket_number), '[]')
        from public.delivery_tickets dt
        where dt.order_id = v_s.order_id and dt.company_id = v_company and dt.status = 'accepted'))
    from public.orders o where o.id = v_s.order_id and o.company_id = v_company;

    perform private.log_event('billing.handed_off', 'order', v_s.order_id,
      format('Handed off for billing in batch %s%s', v_batch.batch_number,
             case when v_ref <> '' then ' (' || v_ref || ')' else '' end),
      jsonb_build_object('handoff_id', v_batch.id, 'batch_number', v_batch.batch_number));
  end loop;

  return jsonb_build_object('handoff_id', v_batch.id, 'batch_number', v_batch.batch_number, 'created', true,
    'orders', array_length(v_ids, 1));
end;
$$;

-- Undo one order's handoff (for example, handed off by mistake). The row stays
-- on record with who undid it and why; the order can then be handed off again.
create or replace function public.revert_billing_handoff(p_handoff_order_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid;
  v_h       public.billing_handoff_orders%rowtype;
  v_batch   text;
  v_number  text;
  v_reason  text := private.clean_text(p_reason, 500, 'Reason');
begin
  perform private.require_permission('billing.manage');
  v_company := private.require_company();
  select * into v_h from public.billing_handoff_orders where id = p_handoff_order_id and company_id = v_company for update;
  if not found then raise exception 'Handoff not found.'; end if;
  if v_h.reverted_at is not null then
    raise exception 'This handoff was already undone.' using errcode = 'PT409';
  end if;
  if length(v_reason) = 0 then raise exception 'Enter the reason for undoing the handoff.'; end if;

  update public.billing_handoff_orders set reverted_at = now(), reverted_by = auth.uid(), revert_reason = v_reason
  where id = v_h.id;
  select batch_number into v_batch from public.billing_handoffs where id = v_h.handoff_id;
  select order_number into v_number from public.orders where id = v_h.order_id;
  perform private.log_event('billing.handoff_undone', 'order', v_h.order_id,
    format('Billing handoff undone (batch %s): %s', v_batch, v_reason),
    jsonb_build_object('handoff_id', v_h.handoff_id, 'batch_number', v_batch));
  return jsonb_build_object('order_id', v_h.order_id, 'order_number', v_number, 'batch_number', v_batch);
end;
$$;

-- Each download of a batch file is counted and logged, so a second download
-- is visible as a repeat of the same batch, never as new work.
create or replace function public.record_billing_export(p_handoff_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid;
  v_b       public.billing_handoffs%rowtype;
begin
  perform private.require_permission('billing.view');
  v_company := private.require_company();
  update public.billing_handoffs
     set export_count = export_count + 1, last_exported_at = now(), last_exported_by = auth.uid()
   where id = p_handoff_id and company_id = v_company
  returning * into v_b;
  if not found then raise exception 'Handoff batch not found.'; end if;
  perform private.log_event('billing.exported', 'billing_handoff', v_b.id,
    format('Billing batch %s downloaded (download %s)', v_b.batch_number, v_b.export_count),
    jsonb_build_object('batch_number', v_b.batch_number, 'export_count', v_b.export_count));
  return jsonb_build_object('batch_number', v_b.batch_number, 'export_count', v_b.export_count);
end;
$$;

-- -----------------------------------------------------------------------------
-- 5. Grants
-- -----------------------------------------------------------------------------
revoke execute on function
  public.acknowledge_billing_exceptions(uuid, text, text),
  public.hand_off_orders(uuid[], text, text, uuid),
  public.revert_billing_handoff(uuid, text),
  public.record_billing_export(uuid)
from public, anon;
grant execute on function
  public.acknowledge_billing_exceptions(uuid, text, text),
  public.hand_off_orders(uuid[], text, text, uuid),
  public.revert_billing_handoff(uuid, text),
  public.record_billing_export(uuid)
to authenticated;

revoke execute on function
  private.add_billing_sequence(),
  private.guard_billing_handoff()
from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 6. Verification
-- -----------------------------------------------------------------------------
do $$
begin
  if (select count(*) from public.role_permissions where permission = 'billing.view')
     <> 2 * (select count(*) from public.companies) then
    raise exception 'billing.view was not granted to owner and office in every company';
  end if;
  if exists (select 1 from public.document_sequences s right join public.companies c
             on c.id = s.company_id and s.key = 'billing' where s.company_id is null) then
    raise exception 'A company has no billing batch sequence';
  end if;
end;
$$;
