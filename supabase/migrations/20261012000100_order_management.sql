-- =============================================================================
-- Order management
--
-- * Scheduling fields on orders (order date, requested date, scheduled date
--   range, daily time window, notes), contact link, edit counter, timestamps.
-- * Status transitions with documented rules (private.order_transition_allowed,
--   mirrored in src/lib/orders/status.ts and tested for parity).
-- * New permission orders.schedule (owner, office, dispatcher): schedule and
--   move orders through delivery. orders.edit: create direct orders, edit
--   details, confirm and cancel.
-- * Direct orders (no quote): public.save_order_draft prices lines with the
--   same rules as quotes (customer list → standard list → manual; overrides and
--   discounts need pricing.override).
-- * Pricing protection: lines and money columns of an order can only change
--   while it is a direct order in Draft. Quote-linked orders keep the accepted
--   prices forever. Enforced by triggers, not just by the functions.
-- * Every function resolves the caller's company and verifies every referenced
--   row belongs to it (see 20261011000200_company_separation.sql).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Permission
-- -----------------------------------------------------------------------------
insert into public.permissions (code, category, description) values
  ('orders.schedule', 'Orders', 'Schedule orders and move them through delivery (scheduled, dispatched, in progress, completed, on hold)');

insert into public.role_permission_defaults (role, permission) values
  ('owner', 'orders.schedule'), ('office', 'orders.schedule'), ('dispatcher', 'orders.schedule');

insert into public.role_permissions (company_id, role, permission)
select c.id, r.role, 'orders.schedule'
from public.companies c
cross join (values ('owner'::public.app_role), ('office'), ('dispatcher')) as r(role)
on conflict do nothing;

-- -----------------------------------------------------------------------------
-- 2. Order columns
-- -----------------------------------------------------------------------------
alter table public.orders
  add column contact_id        uuid,
  add column order_date        date,
  add column requested_date    date,
  add column scheduled_start   date,
  add column scheduled_end     date,
  add column window_start      time,
  add column window_end        time,
  add column scheduling_notes  text not null default '',
  add column edit_seq          integer not null default 1,
  add column confirmed_at      timestamptz,
  add column completed_at      timestamptz,
  add column canceled_at       timestamptz,
  add column updated_by        uuid references auth.users (id) on delete set null;

-- Backfill existing (quote-linked, confirmed) orders without touching updated_at.
alter table public.orders disable trigger orders_touch;
update public.orders o set
  order_date   = (o.created_at at time zone private.business_timezone(o.company_id))::date,
  confirmed_at = case when o.status <> 'draft' then o.created_at end,
  contact_id   = v.contact_id
from public.quote_versions v
where v.id = o.source_quote_version_id;
update public.orders o set
  order_date = (o.created_at at time zone private.business_timezone(o.company_id))::date
where o.order_date is null;
alter table public.orders enable trigger orders_touch;

alter table public.orders
  alter column order_date set not null,
  add constraint orders_contact_fk foreign key (company_id, contact_id)
    references public.customer_contacts (company_id, id) on delete set null (contact_id),
  add constraint orders_schedule_range check (
    (scheduled_start is null and scheduled_end is null)
    or (scheduled_start is not null and (scheduled_end is null or scheduled_end >= scheduled_start))),
  add constraint orders_window check (
    (window_start is null and window_end is null)
    or (window_start is not null and window_end is not null and window_end > window_start));

create index orders_scheduled_idx on public.orders (company_id, scheduled_start);
create index orders_requested_idx on public.orders (company_id, requested_date);

-- -----------------------------------------------------------------------------
-- 3. Pricing protection (database-level)
-- -----------------------------------------------------------------------------
-- Money, customer and source columns of an order can change only while it is a
-- direct order in Draft (recalculated by save_order_draft). Identity columns
-- never change.
create or replace function private.guard_order_pricing()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.order_number is distinct from old.order_number
     or new.source_quote_id is distinct from old.source_quote_id
     or new.source_quote_version_id is distinct from old.source_quote_version_id then
    raise exception 'Order number and source quote cannot change.' using errcode = '42501';
  end if;
  if (old.status <> 'draft' or old.source_quote_id is not null)
     and (new.customer_id, new.tax_rate_bp, new.subtotal_cents, new.discount_cents, new.taxable_cents,
          new.tax_cents, new.total_cents, new.terms)
         is distinct from
         (old.customer_id, old.tax_rate_bp, old.subtotal_cents, old.discount_cents, old.taxable_cents,
          old.tax_cents, old.total_cents, old.terms) then
    raise exception 'Prices, totals, terms and customer of a confirmed or quote-linked order cannot be changed.'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger orders_guard_pricing before update on public.orders
  for each row execute function private.guard_order_pricing();

-- Order lines may be written only for a direct order in Draft, or by the
-- quote-to-order conversion, or removed by the owner-only sample purge.
create or replace function private.guard_order_lines()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_order_id uuid := coalesce(new.order_id, old.order_id);
begin
  if current_setting('tlt.order_conversion', true) = 'on'
     or (tg_op = 'DELETE' and current_setting('tlt.sample_purge', true) = 'on') then
    return coalesce(new, old);
  end if;
  if not exists (
    select 1 from public.orders o
    where o.id = v_order_id and o.status = 'draft' and o.source_quote_id is null
  ) then
    raise exception 'Lines of a confirmed or quote-linked order cannot be changed.' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and new.order_id <> old.order_id then
    raise exception 'Order lines cannot be moved between orders.' using errcode = '42501';
  end if;
  return coalesce(new, old);
end;
$$;

create trigger order_lines_guard before insert or update or delete on public.order_lines
  for each row execute function private.guard_order_lines();

-- -----------------------------------------------------------------------------
-- 4. Status rules (mirrored in src/lib/orders/status.ts)
--
--   draft               → confirmed, canceled
--   confirmed           → scheduled, on_hold, canceled
--   scheduled           → confirmed (unschedule), dispatched, in_progress, on_hold, canceled
--   dispatched          → scheduled (recall), in_progress, on_hold, canceled
--   in_progress         → partially_completed, completed, on_hold
--   partially_completed → in_progress, completed, on_hold
--   on_hold             → confirmed, scheduled, canceled
--   completed, canceled → (final)
--
-- Requirements: scheduled / dispatched / in_progress need a scheduled start
-- date; on_hold and canceled need a reason; confirming needs at least one
-- line. Permissions: confirming a draft and canceling need orders.edit; every
-- other change needs orders.schedule.
-- -----------------------------------------------------------------------------
create or replace function private.order_transition_allowed(p_from public.order_status, p_to public.order_status)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select (p_from, p_to) in (
    ('draft'::public.order_status, 'confirmed'::public.order_status),
    ('draft', 'canceled'),
    ('confirmed', 'scheduled'), ('confirmed', 'on_hold'), ('confirmed', 'canceled'),
    ('scheduled', 'confirmed'), ('scheduled', 'dispatched'), ('scheduled', 'in_progress'),
    ('scheduled', 'on_hold'), ('scheduled', 'canceled'),
    ('dispatched', 'scheduled'), ('dispatched', 'in_progress'), ('dispatched', 'on_hold'), ('dispatched', 'canceled'),
    ('in_progress', 'partially_completed'), ('in_progress', 'completed'), ('in_progress', 'on_hold'),
    ('partially_completed', 'in_progress'), ('partially_completed', 'completed'), ('partially_completed', 'on_hold'),
    ('on_hold', 'confirmed'), ('on_hold', 'scheduled'), ('on_hold', 'canceled')
  )
$$;

create or replace function private.order_transition_permission(p_from public.order_status, p_to public.order_status)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_to = 'canceled' then 'orders.edit'
    when p_from = 'draft' and p_to = 'confirmed' then 'orders.edit'
    else 'orders.schedule'
  end
$$;

-- -----------------------------------------------------------------------------
-- 5. Helpers
-- -----------------------------------------------------------------------------
create or replace function private.jsonb_changes(p_old jsonb, p_new jsonb, p_keys text[])
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select coalesce(jsonb_object_agg(k, jsonb_build_object('from', p_old -> k, 'to', p_new -> k)), '{}'::jsonb)
  from unnest(p_keys) k
  where (p_old -> k) is distinct from (p_new -> k)
$$;

create or replace function private.recompute_order_totals(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_subtotal bigint;
  v_discount bigint;
  v_taxable  bigint;
  v_tax_bp   integer;
  v_tax      bigint;
begin
  select tax_rate_bp into v_tax_bp from public.orders where id = p_order_id;

  select
    coalesce(sum(amount_cents) filter (where kind <> 'discount'), 0),
    coalesce(-sum(amount_cents) filter (where kind = 'discount'), 0),
    greatest(coalesce(sum(amount_cents) filter (where taxable), 0), 0)
  into v_subtotal, v_discount, v_taxable
  from public.order_lines
  where order_id = p_order_id;

  v_tax := round(v_taxable::numeric * v_tax_bp / 10000)::bigint;

  update public.orders set
    subtotal_cents = v_subtotal,
    discount_cents = v_discount,
    taxable_cents  = v_taxable,
    tax_cents      = v_tax,
    total_cents    = v_subtotal - v_discount + v_tax
  where id = p_order_id;
end;
$$;

-- Bill-to snapshot of a customer (same shape as quote_versions.bill_to_snapshot).
create or replace function private.customer_bill_to(p_customer_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'customer_number', c.customer_number, 'name', c.name, 'email', c.email, 'phone', c.phone,
    'line1', c.billing_line1, 'line2', c.billing_line2, 'city', c.billing_city,
    'state', c.billing_state, 'postal_code', c.billing_postal_code,
    'payment_terms', c.payment_terms)
  from public.customers c where c.id = p_customer_id
$$;

-- Validates and stores contact / job-site / dates shared by direct-order saves
-- and detail edits. Caller has verified the order belongs to v_company and
-- that the customer is the order's customer.
create or replace function private.apply_order_details(
  p_order_id uuid,
  p_company_id uuid,
  p_customer_id uuid,
  p_payload jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_contact_id uuid := nullif(p_payload ->> 'contact_id', '')::uuid;
  v_site_id    uuid := nullif(p_payload ->> 'site_id', '')::uuid;
  v_requested  date := nullif(p_payload ->> 'requested_date', '')::date;
  v_order_date date;
begin
  select order_date into v_order_date from public.orders where id = p_order_id;

  if v_contact_id is not null and not exists (
    select 1 from public.customer_contacts
    where id = v_contact_id and customer_id = p_customer_id and company_id = p_company_id) then
    raise exception 'The selected contact does not belong to this customer.';
  end if;

  if v_site_id is not null and not exists (
    select 1 from public.customer_sites
    where id = v_site_id and customer_id = p_customer_id and company_id = p_company_id) then
    raise exception 'The selected job site does not belong to this customer.';
  end if;

  if v_site_id is null
     and coalesce((p_payload ->> 'save_site')::boolean, false)
     and length(trim(coalesce(p_payload ->> 'site_line1', ''))) > 0 then
    if not private.has_permission('customers.edit') then
      raise exception 'You do not have permission to add job sites to customers.' using errcode = '42501';
    end if;
    insert into public.customer_sites (company_id, customer_id, label, line1, line2, city, state, postal_code)
    values (
      p_company_id, p_customer_id,
      coalesce(nullif(private.clean_text(p_payload ->> 'site_label', 120, 'Job site name'), ''),
               private.clean_text(p_payload ->> 'site_line1', 200, 'Job site address')),
      private.clean_text(p_payload ->> 'site_line1', 200, 'Job site address'),
      private.clean_text(p_payload ->> 'site_line2', 200, 'Job site address line 2'),
      private.clean_text(p_payload ->> 'site_city', 80, 'Job site city'),
      private.clean_text(p_payload ->> 'site_state', 2, 'Job site state'),
      private.clean_text(p_payload ->> 'site_postal_code', 10, 'Job site ZIP'))
    returning id into v_site_id;
  end if;

  if v_requested is not null and v_requested < v_order_date then
    raise exception 'The requested delivery date cannot be before the order date.';
  end if;

  update public.orders set
    contact_id       = v_contact_id,
    contact_name     = private.clean_text(p_payload ->> 'contact_name', 120, 'Contact name'),
    contact_email    = private.clean_text(p_payload ->> 'contact_email', 254, 'Contact email'),
    contact_phone    = private.clean_text(p_payload ->> 'contact_phone', 40, 'Contact phone'),
    site_id          = v_site_id,
    site_label       = private.clean_text(p_payload ->> 'site_label', 120, 'Job site name'),
    site_line1       = private.clean_text(p_payload ->> 'site_line1', 200, 'Job site address'),
    site_line2       = private.clean_text(p_payload ->> 'site_line2', 200, 'Job site address line 2'),
    site_city        = private.clean_text(p_payload ->> 'site_city', 80, 'Job site city'),
    site_state       = private.clean_text(p_payload ->> 'site_state', 2, 'Job site state'),
    site_postal_code = private.clean_text(p_payload ->> 'site_postal_code', 10, 'Job site ZIP'),
    project_name     = private.clean_text(p_payload ->> 'project_name', 160, 'Project name'),
    customer_po      = private.clean_text(p_payload ->> 'customer_po', 60, 'Customer PO'),
    job_instructions = private.clean_text(p_payload ->> 'job_instructions', 4000, 'Job instructions'),
    internal_notes   = private.clean_text(p_payload ->> 'internal_notes', 4000, 'Internal notes'),
    requested_date   = v_requested
  where id = p_order_id;
end;
$$;

-- Fields recorded in the audit log when an order changes.
create or replace function private.order_audit_fields()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array['contact_id', 'contact_name', 'contact_email', 'contact_phone', 'site_id', 'site_label',
               'site_line1', 'site_line2', 'site_city', 'site_state', 'site_postal_code', 'project_name',
               'customer_po', 'job_instructions', 'internal_notes', 'requested_date', 'order_date',
               'scheduled_start', 'scheduled_end', 'window_start', 'window_end', 'scheduling_notes',
               'customer_id', 'tax_rate_bp', 'terms', 'total_cents']
$$;

-- -----------------------------------------------------------------------------
-- 6. Direct orders: create or edit a Draft order without a quote
-- -----------------------------------------------------------------------------
-- Payload: order_id (null = new), expected_edit_seq, customer_id, order_date,
-- requested_date, contact_*/site_*/save_site, project_name, customer_po,
-- job_instructions, terms, internal_notes, tax_rate_bp, lines[].
-- Lines are priced exactly like quote lines (save_quote_draft) on the order
-- date: customer list → standard list → manual; a different rate or a
-- discount needs pricing.override.
create or replace function public.save_order_draft(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order        public.orders%rowtype;
  v_customer     public.customers%rowtype;
  v_is_new       boolean := nullif(p_payload ->> 'order_id', '') is null;
  v_line         jsonb;
  v_line_no      integer := 0;
  v_lines        jsonb := coalesce(p_payload -> 'lines', '[]'::jsonb);
  v_kind         public.charge_kind;
  v_method       public.calc_method;
  v_material_id  uuid;
  v_charge_id    uuid;
  v_unit_code    text;
  v_unit_label   text;
  v_quantity     numeric;
  v_rate         bigint;
  v_percent      integer;
  v_taxable      boolean;
  v_desc         text;
  v_cat_rate     bigint;
  v_cat_percent  integer;
  v_cat_source   text;
  v_source       public.price_source;
  v_base         bigint := 0;
  v_amount       bigint;
  v_needs_override boolean := false;
  v_order_date   date;
  v_tax_bp       integer;
  v_item_ok      boolean;
  v_company      uuid;
  v_before       jsonb;
begin
  perform private.require_permission('orders.edit');
  v_company := private.require_company();

  if jsonb_typeof(v_lines) <> 'array' then
    raise exception 'Lines must be a list.';
  end if;
  if jsonb_array_length(v_lines) > 200 then
    raise exception 'An order can have at most 200 lines.';
  end if;

  select * into v_customer from public.customers
  where id = nullif(p_payload ->> 'customer_id', '')::uuid and company_id = v_company;
  if not found then
    raise exception 'Select a customer for this order.';
  end if;

  v_order_date := coalesce(nullif(p_payload ->> 'order_date', '')::date, private.business_today(v_company));
  if v_order_date < private.business_today(v_company) - 366 or v_order_date > private.business_today(v_company) + 366 then
    raise exception 'The order date must be within a year of today.';
  end if;

  v_tax_bp := coalesce((p_payload ->> 'tax_rate_bp')::integer, 0);
  if v_tax_bp < 0 or v_tax_bp > 2500 then
    raise exception 'Tax rate must be between 0%% and 25%%.';
  end if;
  if v_customer.tax_exempt then
    v_tax_bp := 0;
  end if;

  -- Locate / create the order -------------------------------------------------
  if v_is_new then
    if not v_customer.active then
      raise exception 'Customer % is archived. Reactivate the customer before creating an order.', v_customer.name;
    end if;

    insert into public.orders (
      company_id, order_number, customer_id, status, bill_to_snapshot, order_date, terms,
      tax_rate_bp, is_sample, created_by, updated_by)
    values (
      v_company, private.next_document_number(v_company, 'order'), v_customer.id, 'draft',
      private.customer_bill_to(v_customer.id), v_order_date,
      private.clean_text(p_payload ->> 'terms', 8000, 'Terms'),
      v_tax_bp, v_customer.is_sample, auth.uid(), auth.uid())
    returning * into v_order;

    insert into public.order_status_events (company_id, order_id, from_status, to_status, note, actor_id)
    values (v_company, v_order.id, null, 'draft', 'Direct order created', auth.uid());
  else
    select * into v_order from public.orders
    where id = (p_payload ->> 'order_id')::uuid and company_id = v_company for update;
    if not found then
      raise exception 'Order not found.';
    end if;
    if v_order.source_quote_id is not null then
      raise exception 'Order % was created from a quote. Its prices and lines cannot be changed.', v_order.order_number
        using errcode = '42501';
    end if;
    if v_order.status <> 'draft' then
      raise exception 'Order % is %. Lines and prices can only be changed while the order is a draft.',
        v_order.order_number, replace(v_order.status::text, '_', ' ') using errcode = '42501';
    end if;
    if (p_payload ->> 'expected_edit_seq') is not null
       and (p_payload ->> 'expected_edit_seq')::integer <> v_order.edit_seq then
      raise exception 'This order was changed by someone else while you were editing. Reload to see the latest version.'
        using errcode = 'PT409';
    end if;
    if v_customer.id <> v_order.customer_id and not v_customer.active then
      raise exception 'Customer % is archived.', v_customer.name;
    end if;
    v_before := to_jsonb(v_order);

    update public.orders set
      customer_id      = v_customer.id,
      bill_to_snapshot = private.customer_bill_to(v_customer.id),
      order_date       = v_order_date,
      terms            = private.clean_text(p_payload ->> 'terms', 8000, 'Terms'),
      tax_rate_bp      = v_tax_bp,
      is_sample        = v_customer.is_sample,
      edit_seq         = edit_seq + 1,
      updated_by       = auth.uid()
    where id = v_order.id;
  end if;

  perform private.apply_order_details(v_order.id, v_company, v_customer.id, p_payload);

  -- Lines -------------------------------------------------------------------
  delete from public.order_lines where order_id = v_order.id;

  begin
    select coalesce(sum(round((value ->> 'quantity')::numeric * (value ->> 'unit_rate_cents')::bigint)), 0)::bigint
      into v_base
    from jsonb_array_elements(v_lines)
    where value ->> 'calc_method' = 'per_unit' and value ->> 'kind' <> 'discount';
  exception when others then
    v_base := 0;
  end;

  for v_line in
    select value from jsonb_array_elements(v_lines) with ordinality as t(value, ord)
    order by ord
  loop
    v_line_no := v_line_no + 1;
    v_kind := (v_line ->> 'kind')::public.charge_kind;
    v_method := (v_line ->> 'calc_method')::public.calc_method;
    v_material_id := nullif(v_line ->> 'material_id', '')::uuid;
    v_charge_id := nullif(v_line ->> 'charge_item_id', '')::uuid;
    v_desc := private.clean_text(v_line ->> 'description', 300, 'Line description');
    v_taxable := coalesce((v_line ->> 'taxable')::boolean, false);
    v_cat_rate := null;
    v_cat_percent := null;
    v_cat_source := null;

    if v_material_id is not null and v_charge_id is not null then
      raise exception 'Line %: choose a material or a charge, not both.', v_line_no;
    end if;
    if v_material_id is not null then
      select true into v_item_ok from public.materials where id = v_material_id and company_id = v_company;
      if v_item_ok is null then raise exception 'Line %: material not found.', v_line_no; end if;
      if v_kind <> 'material' then raise exception 'Line %: material lines must be of type material.', v_line_no; end if;
    end if;
    if v_charge_id is not null then
      select true into v_item_ok from public.charge_items where id = v_charge_id and company_id = v_company;
      if v_item_ok is null then raise exception 'Line %: charge not found.', v_line_no; end if;
    end if;
    v_item_ok := null;

    if length(v_desc) = 0 then
      raise exception 'Line %: a description is required.', v_line_no;
    end if;

    if v_method = 'per_unit' then
      v_unit_code := nullif(v_line ->> 'unit_code', '');
      select label into v_unit_label from public.units_of_measure where code = v_unit_code and company_id = v_company;
      if v_unit_label is null then
        raise exception 'Line %: choose a valid unit.', v_line_no;
      end if;
      v_quantity := (v_line ->> 'quantity')::numeric;
      if v_quantity is null or v_quantity <= 0 or v_quantity > 999999.999 or v_quantity <> round(v_quantity, 3) then
        raise exception 'Line %: quantity must be greater than 0 with at most 3 decimal places.', v_line_no;
      end if;
      v_rate := (v_line ->> 'unit_rate_cents')::bigint;
      if v_rate is null or v_rate < 0 or v_rate > 100000000 then
        raise exception 'Line %: enter a rate between $0.00 and $1,000,000.00.', v_line_no;
      end if;
      v_percent := null;

      select r.rate_cents, r.source into v_cat_rate, v_cat_source
      from private.resolve_price(v_customer.id, v_material_id, v_charge_id, v_unit_code, v_order_date) r;
    else
      if v_kind = 'material' then
        raise exception 'Line %: material lines must be priced per unit.', v_line_no;
      end if;
      v_unit_code := null;
      v_unit_label := '';
      v_quantity := null;
      v_rate := null;
      v_percent := (v_line ->> 'percent_bp')::integer;
      if v_percent is null or v_percent < 1 or v_percent > 10000 then
        raise exception 'Line %: percentage must be between 0.01%% and 100%%.', v_line_no;
      end if;

      select r.percent_bp, r.source into v_cat_percent, v_cat_source
      from private.resolve_price(v_customer.id, null, v_charge_id, null, v_order_date) r;
    end if;

    if v_cat_source is not null then
      if (v_method = 'per_unit' and v_rate = v_cat_rate)
         or (v_method <> 'per_unit' and v_percent = v_cat_percent) then
        v_source := v_cat_source::public.price_source;
      else
        v_source := 'override';
        v_needs_override := true;
      end if;
    else
      v_source := 'manual';
    end if;
    if v_kind = 'discount' then
      v_needs_override := true;
    end if;

    v_amount := private.line_amount_cents(v_kind, v_method, v_quantity, v_rate, v_percent, v_base);

    insert into public.order_lines (
      company_id, order_id, line_no, kind, calc_method, material_id, charge_item_id, description,
      unit_code, unit_label, quantity, unit_rate_cents, percent_bp, catalog_rate_cents,
      catalog_percent_bp, price_source, taxable, amount_cents)
    values (
      v_company, v_order.id, v_line_no, v_kind, v_method, v_material_id, v_charge_id, v_desc,
      v_unit_code, coalesce(v_unit_label, ''), v_quantity, v_rate, v_percent, v_cat_rate,
      v_cat_percent, v_source, v_taxable, v_amount);
    v_unit_label := null;
  end loop;

  if v_needs_override and not private.has_permission('pricing.override') then
    raise exception 'This order contains a discount or a rate that differs from the configured price. '
      'You do not have permission to override pricing.' using errcode = '42501';
  end if;

  perform private.recompute_order_totals(v_order.id);
  select * into v_order from public.orders where id = v_order.id;

  perform private.log_event(
    case when v_is_new then 'order.created' else 'order.updated' end,
    'order', v_order.id,
    format('%s %s (direct order, draft): total %s', v_order.order_number,
           case when v_is_new then 'created' else 'saved' end,
           to_char(v_order.total_cents / 100.0, 'FM999,999,990.00')),
    jsonb_build_object('edit_seq', v_order.edit_seq,
                       'total_cents', v_order.total_cents,
                       'line_count', jsonb_array_length(v_lines),
                       'pricing_override', v_needs_override,
                       'changes', case when v_is_new then '{}'::jsonb
                                       else private.jsonb_changes(v_before, to_jsonb(v_order), private.order_audit_fields()) end));

  return jsonb_build_object(
    'order_id', v_order.id,
    'order_number', v_order.order_number,
    'edit_seq', v_order.edit_seq,
    'total_cents', v_order.total_cents);
end;
$$;

-- -----------------------------------------------------------------------------
-- 7. Edit details of any open order (contact, job site, PO, instructions,
--    notes, requested date). Never touches lines, prices or terms.
-- -----------------------------------------------------------------------------
create or replace function public.update_order_details(p_order_id uuid, p_expected_edit_seq integer, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order   public.orders%rowtype;
  v_after   public.orders%rowtype;
  v_company uuid;
  v_changes jsonb;
begin
  perform private.require_permission('orders.edit');
  v_company := private.require_company();

  select * into v_order from public.orders where id = p_order_id and company_id = v_company for update;
  if not found then
    raise exception 'Order not found.';
  end if;
  if v_order.status in ('completed', 'canceled') then
    raise exception 'Order % is %. Completed and canceled orders cannot be edited.',
      v_order.order_number, v_order.status;
  end if;
  if p_expected_edit_seq is not null and p_expected_edit_seq <> v_order.edit_seq then
    raise exception 'This order was changed by someone else while you were editing. Reload to see the latest version.'
      using errcode = 'PT409';
  end if;

  perform private.apply_order_details(v_order.id, v_company, v_order.customer_id, p_payload);

  update public.orders set edit_seq = edit_seq + 1, updated_by = auth.uid()
  where id = v_order.id
  returning * into v_after;

  v_changes := private.jsonb_changes(to_jsonb(v_order), to_jsonb(v_after), private.order_audit_fields());
  if v_changes <> '{}'::jsonb then
    perform private.log_event('order.updated', 'order', v_order.id,
      format('%s details changed: %s', v_order.order_number,
             (select string_agg(replace(k, '_', ' '), ', ' order by k) from jsonb_object_keys(v_changes) k)),
      jsonb_build_object('edit_seq', v_after.edit_seq, 'changes', v_changes));
  end if;

  return jsonb_build_object('order_id', v_after.id, 'edit_seq', v_after.edit_seq, 'changed', v_changes <> '{}'::jsonb);
end;
$$;

-- -----------------------------------------------------------------------------
-- 8. Scheduling: delivery date range, daily time window, notes
-- -----------------------------------------------------------------------------
create or replace function public.update_order_schedule(p_order_id uuid, p_expected_edit_seq integer, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order   public.orders%rowtype;
  v_after   public.orders%rowtype;
  v_company uuid;
  v_start   date := nullif(p_payload ->> 'scheduled_start', '')::date;
  v_end     date := nullif(p_payload ->> 'scheduled_end', '')::date;
  v_wstart  time := nullif(p_payload ->> 'window_start', '')::time;
  v_wend    time := nullif(p_payload ->> 'window_end', '')::time;
  v_changes jsonb;
begin
  perform private.require_permission('orders.schedule');
  v_company := private.require_company();

  select * into v_order from public.orders where id = p_order_id and company_id = v_company for update;
  if not found then
    raise exception 'Order not found.';
  end if;
  if v_order.status in ('completed', 'canceled') then
    raise exception 'Order % is %. Its schedule cannot be changed.', v_order.order_number, v_order.status;
  end if;
  if p_expected_edit_seq is not null and p_expected_edit_seq <> v_order.edit_seq then
    raise exception 'This order was changed by someone else while you were editing. Reload to see the latest version.'
      using errcode = 'PT409';
  end if;

  if v_start is null and v_end is not null then
    raise exception 'Enter a scheduled start date before an end date.';
  end if;
  if v_start is null and v_order.status in ('scheduled', 'dispatched', 'in_progress', 'partially_completed') then
    raise exception 'A % order needs a scheduled date. Move it back to Confirmed to remove the date.',
      replace(v_order.status::text, '_', ' ');
  end if;
  if v_start is not null and v_start < v_order.order_date then
    raise exception 'The scheduled date cannot be before the order date.';
  end if;
  if v_end is not null and v_end < v_start then
    raise exception 'The scheduled end date must be on or after the start date.';
  end if;
  if (v_wstart is null) <> (v_wend is null) then
    raise exception 'Enter both a start and an end time for the delivery window, or neither.';
  end if;
  if v_wstart is not null and v_wend <= v_wstart then
    raise exception 'The delivery window must end after it starts.';
  end if;

  update public.orders set
    scheduled_start  = v_start,
    scheduled_end    = v_end,
    window_start     = v_wstart,
    window_end       = v_wend,
    scheduling_notes = private.clean_text(p_payload ->> 'scheduling_notes', 2000, 'Scheduling notes'),
    edit_seq         = edit_seq + 1,
    updated_by       = auth.uid()
  where id = v_order.id
  returning * into v_after;

  v_changes := private.jsonb_changes(to_jsonb(v_order), to_jsonb(v_after), private.order_audit_fields());
  if v_changes <> '{}'::jsonb then
    perform private.log_event('order.scheduled', 'order', v_order.id,
      format('%s schedule changed: %s', v_order.order_number,
             coalesce(case when v_start is null then 'no date'
                           else to_char(v_start, 'Mon DD, YYYY')
                                || coalesce(' – ' || to_char(v_end, 'Mon DD, YYYY'), '') end, '')),
      jsonb_build_object('edit_seq', v_after.edit_seq, 'changes', v_changes));
  end if;

  return jsonb_build_object('order_id', v_after.id, 'edit_seq', v_after.edit_seq, 'changed', v_changes <> '{}'::jsonb);
end;
$$;

-- -----------------------------------------------------------------------------
-- 9. Status changes (rules in section 4)
-- -----------------------------------------------------------------------------
create or replace function public.set_order_status(
  p_order_id uuid,
  p_status public.order_status,
  p_note text default '',
  p_expected_edit_seq integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order   public.orders%rowtype;
  v_company uuid;
  v_note    text := private.clean_text(p_note, 1000, 'Note');
  v_from    public.order_status;
begin
  v_company := private.require_company();

  select * into v_order from public.orders where id = p_order_id and company_id = v_company for update;
  if not found then
    raise exception 'Order not found.';
  end if;
  v_from := v_order.status;
  if p_status is null or p_status = v_order.status then
    raise exception 'Order % is already %.', v_order.order_number, replace(v_order.status::text, '_', ' ');
  end if;
  if not private.order_transition_allowed(v_order.status, p_status) then
    raise exception 'Order % cannot move from % to %.', v_order.order_number,
      replace(v_order.status::text, '_', ' '), replace(p_status::text, '_', ' ');
  end if;
  perform private.require_permission(private.order_transition_permission(v_order.status, p_status));
  if p_expected_edit_seq is not null and p_expected_edit_seq <> v_order.edit_seq then
    raise exception 'This order was changed by someone else. Reload to see the latest version.'
      using errcode = 'PT409';
  end if;

  if p_status in ('on_hold', 'canceled') and length(v_note) = 0 then
    raise exception 'Enter a reason for putting the order %.',
      case when p_status = 'canceled' then 'as canceled' else 'on hold' end;
  end if;
  if p_status in ('scheduled', 'dispatched', 'in_progress') and v_order.scheduled_start is null then
    raise exception 'Set a scheduled date before marking the order %.', replace(p_status::text, '_', ' ');
  end if;
  if p_status = 'confirmed' and not exists (select 1 from public.order_lines where order_id = v_order.id) then
    raise exception 'Add at least one line before confirming the order.';
  end if;

  update public.orders set
    status           = p_status,
    status_note      = v_note,
    bill_to_snapshot = case when v_order.status = 'draft' and v_order.source_quote_id is null
                            then private.customer_bill_to(v_order.customer_id) else bill_to_snapshot end,
    confirmed_at     = case when p_status = 'confirmed' then coalesce(confirmed_at, now()) else confirmed_at end,
    completed_at     = case when p_status = 'completed' then now() else completed_at end,
    canceled_at      = case when p_status = 'canceled' then now() else canceled_at end,
    edit_seq         = edit_seq + 1,
    updated_by       = auth.uid()
  where id = v_order.id
  returning * into v_order;

  insert into public.order_status_events (company_id, order_id, from_status, to_status, note, actor_id)
  values (v_company, v_order.id, v_from, p_status, v_note, auth.uid());

  perform private.log_event('order.status_changed', 'order', v_order.id,
    format('%s: %s → %s%s', v_order.order_number, replace(v_from::text, '_', ' '),
           replace(p_status::text, '_', ' '), case when length(v_note) > 0 then ' (' || v_note || ')' else '' end),
    jsonb_build_object('from', v_from, 'to', p_status, 'note', v_note, 'edit_seq', v_order.edit_seq));

  return jsonb_build_object('order_id', v_order.id, 'status', v_order.status, 'edit_seq', v_order.edit_seq);
end;
$$;

-- -----------------------------------------------------------------------------
-- 10. Quote-to-order conversion: unchanged guarantees (row lock, one order per
--     quote, accepted revision copied verbatim); now also records the contact,
--     order date and confirmation time. Lines are written under the
--     tlt.order_conversion flag that the order_lines guard honours.
-- -----------------------------------------------------------------------------
create or replace function public.convert_quote_to_order(p_quote_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_quote    public.quotes%rowtype;
  v_version  public.quote_versions%rowtype;
  v_existing public.orders%rowtype;
  v_order    public.orders%rowtype;
  v_lines    integer;
  v_company  uuid;
begin
  perform private.require_permission('orders.edit');
  v_company := private.require_company();

  -- Serializes concurrent conversions of the same quote.
  select * into v_quote from public.quotes where id = p_quote_id and company_id = v_company for update;
  if not found then
    raise exception 'Quote not found.';
  end if;

  select * into v_existing from public.orders where source_quote_id = p_quote_id and company_id = v_company;
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
    company_id, order_number, customer_id, status, source_quote_id, source_quote_version_id,
    order_date, confirmed_at, contact_id,
    bill_to_snapshot, contact_name, contact_email, contact_phone,
    site_id, site_label, site_line1, site_line2, site_city, site_state, site_postal_code,
    project_name, customer_po, job_instructions, terms, internal_notes,
    tax_rate_bp, subtotal_cents, discount_cents, taxable_cents, tax_cents, total_cents,
    is_sample, created_by, updated_by)
  values (
    v_company, private.next_document_number(v_company, 'order'), v_quote.customer_id, 'confirmed', v_quote.id, v_version.id,
    private.business_today(v_company), now(), v_version.contact_id,
    v_version.bill_to_snapshot, v_version.contact_name, v_version.contact_email, v_version.contact_phone,
    v_version.site_id, v_version.site_label, v_version.site_line1, v_version.site_line2,
    v_version.site_city, v_version.site_state, v_version.site_postal_code,
    v_version.project_name, v_version.customer_po, v_version.job_instructions, v_version.terms,
    v_version.internal_notes,
    v_version.tax_rate_bp, v_version.subtotal_cents, v_version.discount_cents, v_version.taxable_cents,
    v_version.tax_cents, v_version.total_cents,
    v_quote.is_sample, auth.uid(), auth.uid())
  returning * into v_order;

  perform set_config('tlt.order_conversion', 'on', true);

  insert into public.order_lines (
    company_id, order_id, line_no, source_quote_line_id, kind, calc_method, material_id, charge_item_id,
    description, unit_code, unit_label, quantity, unit_rate_cents, percent_bp,
    catalog_rate_cents, catalog_percent_bp, price_source, taxable, amount_cents)
  select
    v_company, v_order.id, l.line_no, l.id, l.kind, l.calc_method, l.material_id, l.charge_item_id,
    l.description, l.unit_code, l.unit_label, l.quantity, l.unit_rate_cents, l.percent_bp,
    l.catalog_rate_cents, l.catalog_percent_bp, l.price_source, l.taxable, l.amount_cents
  from public.quote_lines l
  where l.quote_version_id = v_version.id
  order by l.line_no;
  perform set_config('tlt.order_conversion', 'off', true);

  insert into public.order_status_events (company_id, order_id, from_status, to_status, note, actor_id)
  values (v_company, v_order.id, null, 'confirmed',
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
$function$

;

-- -----------------------------------------------------------------------------
-- 11. Sample-data removal also removes direct orders of sample customers
-- -----------------------------------------------------------------------------
create or replace function public.remove_sample_data()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_quotes integer;
  v_orders integer;
  v_customers integer;
  v_customers_kept integer;
  v_materials integer;
  v_materials_kept integer;
  v_charges integer;
  v_charges_kept integer;
  v_lists integer;
  v_company uuid;
begin
  perform private.require_permission('settings.manage');
  v_company := private.require_company();

  perform set_config('tlt.sample_purge', 'on', true);

  -- Quotes on sample customers are themselves sample data.
  update public.quotes q set is_sample = true
  from public.customers c
  where c.id = q.customer_id and c.is_sample and not q.is_sample and q.company_id = v_company and c.company_id = v_company;

  update public.quotes set current_version_id = null, accepted_version_id = null where is_sample and company_id = v_company;
  delete from public.quotes where is_sample and company_id = v_company;
  get diagnostics v_quotes = row_count;

  -- Direct orders of sample customers (orders from sample quotes went with
  -- their quote above).
  delete from public.orders o
  using public.customers c
  where c.id = o.customer_id and o.company_id = v_company and c.company_id = v_company
    and (o.is_sample or c.is_sample) and o.source_quote_id is null;
  get diagnostics v_orders = row_count;

  delete from public.customers c
  where c.company_id = v_company and c.is_sample
    and not exists (select 1 from public.quotes q where q.customer_id = c.id)
    and not exists (select 1 from public.orders o where o.customer_id = c.id);
  get diagnostics v_customers = row_count;
  update public.customers set active = false where is_sample and company_id = v_company;
  get diagnostics v_customers_kept = row_count;

  delete from public.materials m
  where m.company_id = v_company and m.is_sample
    and not exists (select 1 from public.quote_lines l where l.material_id = m.id)
    and not exists (select 1 from public.order_lines l where l.material_id = m.id);
  get diagnostics v_materials = row_count;
  update public.materials set active = false where is_sample and company_id = v_company;
  get diagnostics v_materials_kept = row_count;

  delete from public.charge_items ci
  where ci.company_id = v_company and ci.is_sample
    and not exists (select 1 from public.quote_lines l where l.charge_item_id = ci.id)
    and not exists (select 1 from public.order_lines l where l.charge_item_id = ci.id);
  get diagnostics v_charges = row_count;
  update public.charge_items set active = false where is_sample and company_id = v_company;
  get diagnostics v_charges_kept = row_count;

  update public.customers set price_list_id = null
  where company_id = v_company and price_list_id in (select id from public.price_lists where is_sample and company_id = v_company);
  delete from public.price_lists where is_sample and company_id = v_company;
  get diagnostics v_lists = row_count;

  perform set_config('tlt.sample_purge', 'off', true);

  perform private.log_event('sample_data.removed', 'system', null,
    format('Sample data removed: %s quotes, %s direct orders, %s customers, %s materials, %s charges, %s price lists',
           v_quotes, v_orders, v_customers, v_materials, v_charges, v_lists),
    jsonb_build_object('quotes', v_quotes, 'direct_orders', v_orders, 'customers', v_customers, 'materials', v_materials,
                       'charge_items', v_charges, 'price_lists', v_lists,
                       'deactivated_in_use', jsonb_build_object(
                         'customers', v_customers_kept, 'materials', v_materials_kept,
                         'charge_items', v_charges_kept)));

  return jsonb_build_object('quotes', v_quotes, 'direct_orders', v_orders, 'customers', v_customers, 'materials', v_materials,
                            'charge_items', v_charges, 'price_lists', v_lists,
                            'deactivated_in_use', v_customers_kept + v_materials_kept + v_charges_kept);
end;
$function$

;

-- -----------------------------------------------------------------------------
-- 12. Order list (columns appended; security_invoker keeps RLS of the caller)
-- -----------------------------------------------------------------------------
create or replace view public.order_list
with (security_invoker = true) as
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
  o.created_at,
  o.company_id,
  o.order_date,
  o.requested_date,
  o.scheduled_start,
  o.scheduled_end,
  o.window_start,
  o.window_end,
  o.contact_name,
  o.status_note,
  o.updated_at,
  (select string_agg(l.description, ', ' order by l.line_no)
     from public.order_lines l
    where l.order_id = o.id and l.kind = 'material') as material_summary
from public.orders o
join public.customers c on c.id = o.customer_id
left join public.quotes q on q.id = o.source_quote_id;

-- -----------------------------------------------------------------------------
-- 13. Grants
-- -----------------------------------------------------------------------------
revoke execute on function
  public.save_order_draft(jsonb),
  public.update_order_details(uuid, integer, jsonb),
  public.update_order_schedule(uuid, integer, jsonb),
  public.set_order_status(uuid, public.order_status, text, integer)
from public, anon;

grant execute on function
  public.save_order_draft(jsonb),
  public.update_order_details(uuid, integer, jsonb),
  public.update_order_schedule(uuid, integer, jsonb),
  public.set_order_status(uuid, public.order_status, text, integer)
to authenticated;

revoke execute on function
  private.guard_order_pricing(),
  private.guard_order_lines(),
  private.order_transition_allowed(public.order_status, public.order_status),
  private.order_transition_permission(public.order_status, public.order_status),
  private.jsonb_changes(jsonb, jsonb, text[]),
  private.recompute_order_totals(uuid),
  private.customer_bill_to(uuid),
  private.apply_order_details(uuid, uuid, uuid, jsonb),
  private.order_audit_fields()
from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 14. Verification — abort if existing orders were changed
-- -----------------------------------------------------------------------------
do $$
declare
  v_bad bigint;
begin
  select count(*) into v_bad from public.orders where order_date is null;
  if v_bad <> 0 then
    raise exception '% orders have no order date', v_bad;
  end if;

  -- Order totals still equal the accepted revision they came from.
  select count(*) into v_bad
  from public.orders o
  join public.quote_versions v on v.id = o.source_quote_version_id
  where (o.subtotal_cents, o.discount_cents, o.tax_cents, o.total_cents)
        is distinct from (v.subtotal_cents, v.discount_cents, v.tax_cents, v.total_cents);
  if v_bad <> 0 then
    raise exception '% quote-linked orders differ from their accepted revision', v_bad;
  end if;

  select count(*) into v_bad from public.role_permissions
  where permission = 'orders.schedule' and role in ('owner', 'office', 'dispatcher');
  if v_bad <> 3 * (select count(*) from public.companies) then
    raise exception 'orders.schedule was not granted to every company';
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- 15. Configured prices are also available to people who create direct orders
-- -----------------------------------------------------------------------------
create or replace function public.effective_prices(p_customer_id uuid, p_on date)
 RETURNS TABLE(material_id uuid, charge_item_id uuid, unit_code text, rate_cents bigint, percent_bp integer, source text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_company uuid;
begin
  if not (private.has_permission('quotes.view') or private.has_permission('orders.edit')) then
    raise exception 'You do not have permission to view prices.' using errcode = '42501';
  end if;
  v_company := private.require_company();
  if not exists (select 1 from public.customers c where c.id = p_customer_id and c.company_id = v_company) then
    raise exception 'Customer not found.';
  end if;

  return query
  with lists as (
    select c.price_list_id as list_id, 1 as priority, 'customer'::text as src
    from public.customers c
    join public.price_lists pl
      on pl.company_id = v_company and pl.id = c.price_list_id and pl.active and not pl.is_standard
    where c.id = p_customer_id and c.company_id = v_company
    union all
    select pl.id, 2, 'standard'
    from public.price_lists pl
    where pl.company_id = v_company and pl.is_standard and pl.active
  ),
  ranked as (
    select e.material_id, e.charge_item_id, e.unit_code, e.rate_cents, e.percent_bp, l.src,
           row_number() over (
             partition by coalesce(e.material_id, e.charge_item_id), e.unit_code
             order by l.priority, e.effective_from desc
           ) as rn
    from lists l
    join public.price_list_entries e on e.price_list_id = l.list_id and e.company_id = v_company
    where e.effective_from <= p_on
      and (e.effective_to is null or e.effective_to >= p_on)
  )
  select r.material_id, r.charge_item_id, r.unit_code, r.rate_cents, r.percent_bp, r.src
  from ranked r
  where r.rn = 1;
end;
$function$

;

-- -----------------------------------------------------------------------------
-- 16. Order history: people who can view orders can read the audit entries of
--     orders (only those) in their own company. The full audit log still
--     needs audit.view.
-- -----------------------------------------------------------------------------
create policy audit_read_orders on public.audit_events for select to authenticated
  using (
    company_id = (select private.current_company_id())
    and entity_type = 'order'
    and (select private.has_permission('orders.view'))
  );
