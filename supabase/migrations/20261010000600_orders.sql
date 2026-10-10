-- =============================================================================
-- Orders created from accepted quotes.
--
-- An order copies the accepted quote revision: customer (bill-to snapshot),
-- contact, job site, PO, instructions, terms, tax rate, totals and every line
-- with its pricing snapshot (including owner-approved overrides and
-- discounts). The quote and its revisions are not modified.
--
-- Conversion is idempotent: one order per quote (unique source_quote_id),
-- serialized by a row lock on the quote. Clients cannot write order tables
-- directly; changes go through SECURITY DEFINER functions.
-- =============================================================================

create type public.order_status as enum (
  'draft', 'confirmed', 'scheduled', 'dispatched', 'in_progress',
  'partially_completed', 'completed', 'on_hold', 'canceled'
);

-- -----------------------------------------------------------------------------
-- Permissions
-- -----------------------------------------------------------------------------
insert into public.permissions (code, category, description) values
  ('orders.view', 'Orders', 'View orders and order history'),
  ('orders.edit', 'Orders', 'Create orders (including converting accepted quotes) and edit orders');

insert into public.role_permissions (role, permission) values
  ('owner', 'orders.view'), ('owner', 'orders.edit'),
  ('office', 'orders.view'), ('office', 'orders.edit'),
  ('dispatcher', 'orders.view');

-- -----------------------------------------------------------------------------
-- Tables
-- -----------------------------------------------------------------------------
create table public.orders (
  id                       uuid primary key default gen_random_uuid(),
  order_number             text not null unique,
  customer_id              uuid not null references public.customers (id),
  status                   public.order_status not null default 'confirmed',
  -- Permanent link to the source quote and the exact revision accepted.
  -- Null only for future direct orders.
  source_quote_id          uuid unique references public.quotes (id) on delete restrict,
  source_quote_version_id  uuid references public.quote_versions (id) on delete restrict,
  -- Copied from the accepted revision
  bill_to_snapshot         jsonb,
  contact_name             text not null default '',
  contact_email            text not null default '',
  contact_phone            text not null default '',
  site_id                  uuid references public.customer_sites (id) on delete set null,
  site_label               text not null default '',
  site_line1               text not null default '',
  site_line2               text not null default '',
  site_city                text not null default '',
  site_state               text not null default '',
  site_postal_code         text not null default '',
  project_name             text not null default '',
  customer_po              text not null default '',
  job_instructions         text not null default '',
  terms                    text not null default '',
  internal_notes           text not null default '',
  tax_rate_bp              integer not null default 0 check (tax_rate_bp between 0 and 2500),
  subtotal_cents           bigint not null default 0,
  discount_cents           bigint not null default 0,
  taxable_cents            bigint not null default 0,
  tax_cents                bigint not null default 0,
  total_cents              bigint not null default 0,
  status_note              text not null default '',
  is_sample                boolean not null default false,
  created_by               uuid references auth.users (id) on delete set null,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  constraint orders_source_pair check ((source_quote_id is null) = (source_quote_version_id is null))
);

create index orders_customer_idx on public.orders (customer_id);
create index orders_status_idx on public.orders (status);
create index orders_created_idx on public.orders (created_at desc);

create table public.order_lines (
  id                    uuid primary key default gen_random_uuid(),
  order_id              uuid not null references public.orders (id) on delete cascade,
  line_no               integer not null check (line_no >= 1),
  source_quote_line_id  uuid references public.quote_lines (id) on delete restrict,
  kind                  public.charge_kind not null,
  calc_method           public.calc_method not null,
  material_id           uuid references public.materials (id),
  charge_item_id        uuid references public.charge_items (id),
  description           text not null check (length(trim(description)) between 1 and 300),
  unit_code             text references public.units_of_measure (code),
  unit_label            text not null default '',
  quantity              numeric(12, 3),
  unit_rate_cents       bigint,
  percent_bp            integer,
  catalog_rate_cents    bigint,
  catalog_percent_bp    integer,
  price_source          public.price_source not null,
  taxable               boolean not null default false,
  amount_cents          bigint not null,
  unique (order_id, line_no),
  constraint order_lines_item check (num_nonnulls(material_id, charge_item_id) <= 1),
  constraint order_lines_per_unit check (
    calc_method <> 'per_unit' or (quantity is not null and quantity > 0 and unit_rate_cents is not null and unit_code is not null)
  ),
  constraint order_lines_percent check (
    calc_method <> 'percent_of_subtotal' or (percent_bp is not null and quantity is null and unit_rate_cents is null)
  )
);

create index order_lines_order_idx on public.order_lines (order_id);

create table public.order_status_events (
  id           uuid primary key default gen_random_uuid(),
  order_id     uuid not null references public.orders (id) on delete cascade,
  from_status  public.order_status,
  to_status    public.order_status not null,
  note         text not null default '',
  actor_id     uuid references auth.users (id) on delete set null,
  occurred_at  timestamptz not null default now()
);

create index order_status_events_order_idx on public.order_status_events (order_id, occurred_at desc);

create trigger orders_touch before update on public.orders
  for each row execute function private.touch_updated_at();
create trigger order_status_events_append_only before update or delete on public.order_status_events
  for each row execute function private.prevent_modification();

-- -----------------------------------------------------------------------------
-- Convert an accepted quote into an order (idempotent).
-- Returns { order_id, order_number, created } — created = false when the
-- quote had already been converted (double click, retry, second user).
-- -----------------------------------------------------------------------------
create or replace function public.convert_quote_to_order(p_quote_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_quote    public.quotes%rowtype;
  v_version  public.quote_versions%rowtype;
  v_existing public.orders%rowtype;
  v_order    public.orders%rowtype;
  v_lines    integer;
begin
  perform private.require_permission('orders.edit');

  -- Serializes concurrent conversions of the same quote.
  select * into v_quote from public.quotes where id = p_quote_id for update;
  if not found then
    raise exception 'Quote not found.';
  end if;

  select * into v_existing from public.orders where source_quote_id = p_quote_id;
  if found then
    return jsonb_build_object('order_id', v_existing.id, 'order_number', v_existing.order_number, 'created', false);
  end if;

  if v_quote.status <> 'accepted' then
    raise exception 'Quote % is %. Only accepted quotes can be converted to an order.',
      v_quote.quote_number, v_quote.status;
  end if;

  select * into v_version from public.quote_versions where id = v_quote.accepted_version_id;
  if not found or v_version.locked_at is null then
    raise exception 'Quote % has no issued accepted revision to convert.', v_quote.quote_number;
  end if;

  select count(*) into v_lines from public.quote_lines where quote_version_id = v_version.id;
  if v_lines = 0 then
    raise exception 'Quote % has no lines to convert.', v_quote.quote_number;
  end if;

  insert into public.orders (
    order_number, customer_id, status, source_quote_id, source_quote_version_id,
    bill_to_snapshot, contact_name, contact_email, contact_phone,
    site_id, site_label, site_line1, site_line2, site_city, site_state, site_postal_code,
    project_name, customer_po, job_instructions, terms, internal_notes,
    tax_rate_bp, subtotal_cents, discount_cents, taxable_cents, tax_cents, total_cents,
    is_sample, created_by)
  values (
    private.next_document_number('order'), v_quote.customer_id, 'confirmed', v_quote.id, v_version.id,
    v_version.bill_to_snapshot, v_version.contact_name, v_version.contact_email, v_version.contact_phone,
    v_version.site_id, v_version.site_label, v_version.site_line1, v_version.site_line2,
    v_version.site_city, v_version.site_state, v_version.site_postal_code,
    v_version.project_name, v_version.customer_po, v_version.job_instructions, v_version.terms,
    v_version.internal_notes,
    v_version.tax_rate_bp, v_version.subtotal_cents, v_version.discount_cents, v_version.taxable_cents,
    v_version.tax_cents, v_version.total_cents,
    v_quote.is_sample, auth.uid())
  returning * into v_order;

  insert into public.order_lines (
    order_id, line_no, source_quote_line_id, kind, calc_method, material_id, charge_item_id,
    description, unit_code, unit_label, quantity, unit_rate_cents, percent_bp,
    catalog_rate_cents, catalog_percent_bp, price_source, taxable, amount_cents)
  select
    v_order.id, l.line_no, l.id, l.kind, l.calc_method, l.material_id, l.charge_item_id,
    l.description, l.unit_code, l.unit_label, l.quantity, l.unit_rate_cents, l.percent_bp,
    l.catalog_rate_cents, l.catalog_percent_bp, l.price_source, l.taxable, l.amount_cents
  from public.quote_lines l
  where l.quote_version_id = v_version.id
  order by l.line_no;

  insert into public.order_status_events (order_id, from_status, to_status, note, actor_id)
  values (v_order.id, null, 'confirmed',
          format('Created from quote %s revision %s', v_quote.quote_number, v_version.version_no), auth.uid());

  perform private.log_event('order.created_from_quote', 'order', v_order.id,
    format('%s created from %s (revision %s), total %s', v_order.order_number, v_quote.quote_number,
           v_version.version_no, to_char(v_order.total_cents / 100.0, 'FM999,999,990.00')),
    jsonb_build_object('quote_id', v_quote.id, 'quote_version_id', v_version.id, 'line_count', v_lines));
  perform private.log_event('quote.converted_to_order', 'quote', v_quote.id,
    format('%s converted to order %s', v_quote.quote_number, v_order.order_number),
    jsonb_build_object('order_id', v_order.id));

  return jsonb_build_object('order_id', v_order.id, 'order_number', v_order.order_number, 'created', true);
end;
$$;

-- -----------------------------------------------------------------------------
-- An accepted quote that became an order cannot be canceled; cancel the order
-- instead (order status changes arrive with the order-management phase).
-- -----------------------------------------------------------------------------
create or replace function private.guard_converted_quote()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status is distinct from old.status
     and exists (select 1 from public.orders o where o.source_quote_id = old.id) then
    raise exception 'Quote % has been converted to an order and its status can no longer change.', old.quote_number;
  end if;
  return new;
end;
$$;

create trigger quotes_guard_converted before update of status on public.quotes
  for each row execute function private.guard_converted_quote();

-- -----------------------------------------------------------------------------
-- Sample data: orders created from sample quotes are sample data too.
-- -----------------------------------------------------------------------------
create or replace function private.prevent_modification()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE'
     and current_setting('tlt.sample_purge', true) = 'on'
     and tg_table_name in ('quote_status_events', 'email_deliveries', 'documents', 'order_status_events') then
    return old;
  end if;
  raise exception '% rows are append-only and cannot be changed or deleted.', tg_table_name
    using errcode = '42501';
end;
$$;

-- While public.remove_sample_data() deletes a sample quote, remove the order
-- created from it first (the order would otherwise block the delete).
create or replace function private.purge_sample_quote_orders()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if current_setting('tlt.sample_purge', true) = 'on' then
    delete from public.orders where source_quote_id = old.id;
  end if;
  return old;
end;
$$;

create trigger quotes_purge_sample_orders before delete on public.quotes
  for each row execute function private.purge_sample_quote_orders();

create or replace function public.sample_data_counts()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'customers', (select count(*) from public.customers where is_sample),
    'materials', (select count(*) from public.materials where is_sample),
    'charge_items', (select count(*) from public.charge_items where is_sample),
    'price_lists', (select count(*) from public.price_lists where is_sample),
    'quotes', (select count(*) from public.quotes where is_sample),
    'orders', (select count(*) from public.orders where is_sample)
  )
  where private.current_app_role() is not null
$$;

-- -----------------------------------------------------------------------------
-- List view (security_invoker so RLS of the underlying tables applies)
-- -----------------------------------------------------------------------------
create view public.order_list
with (security_invoker = true)
as
select
  o.id,
  o.order_number,
  o.status,
  o.customer_id,
  c.name as customer_name,
  c.customer_number,
  o.source_quote_id,
  q.quote_number as source_quote_number,
  o.project_name,
  o.site_label,
  o.site_line1,
  o.site_city,
  o.customer_po,
  o.total_cents,
  o.is_sample,
  o.created_at
from public.orders o
join public.customers c on c.id = o.customer_id
left join public.quotes q on q.id = o.source_quote_id;

-- -----------------------------------------------------------------------------
-- RLS and grants: read-only for clients.
-- -----------------------------------------------------------------------------
alter table public.orders enable row level security;
alter table public.order_lines enable row level security;
alter table public.order_status_events enable row level security;

create policy orders_read on public.orders for select to authenticated
  using (private.has_permission('orders.view'));
create policy order_lines_read on public.order_lines for select to authenticated
  using (private.has_permission('orders.view'));
create policy order_status_events_read on public.order_status_events for select to authenticated
  using (private.has_permission('orders.view'));

revoke all on public.orders, public.order_lines, public.order_status_events, public.order_list from anon, authenticated;
grant select on public.orders, public.order_lines, public.order_status_events, public.order_list to authenticated;

revoke execute on function public.convert_quote_to_order(uuid) from public, anon;
grant execute on function public.convert_quote_to_order(uuid) to authenticated;
revoke execute on all functions in schema private from public, anon;
