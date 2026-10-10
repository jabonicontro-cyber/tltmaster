-- =============================================================================
-- Customers, contacts, job sites; units of measure, materials, charge items,
-- price lists.
-- =============================================================================

create type public.customer_type as enum ('commercial', 'residential');
create type public.charge_kind as enum ('material', 'hauling', 'service', 'surcharge', 'discount', 'other');
create type public.calc_method as enum ('per_unit', 'percent_of_subtotal');

-- -----------------------------------------------------------------------------
-- Units of measure
-- -----------------------------------------------------------------------------
create table public.units_of_measure (
  code          text primary key check (code ~ '^[a-z0-9_]{1,20}$'),
  label         text not null,              -- plural display label, e.g. "Tons"
  abbreviation  text not null,              -- e.g. "ton"
  active        boolean not null default true,
  sort_order    integer not null default 100,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

insert into public.units_of_measure (code, label, abbreviation, sort_order) values
  ('ton',   'Tons',        'ton',  10),
  ('load',  'Loads',       'load', 20),
  ('cu_yd', 'Cubic yards', 'cu yd', 30),
  ('hour',  'Hours',       'hr',   40),
  ('mile',  'Miles',       'mi',   50),
  ('day',   'Days',        'day',  60),
  ('each',  'Each',        'ea',   70);

create trigger units_touch before update on public.units_of_measure
  for each row execute function private.touch_updated_at();

-- -----------------------------------------------------------------------------
-- Customers
-- -----------------------------------------------------------------------------
create table public.price_lists (
  id           uuid primary key default gen_random_uuid(),
  name         text not null check (length(trim(name)) between 1 and 120),
  description  text not null default '',
  is_standard  boolean not null default false,
  active       boolean not null default true,
  is_sample    boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create unique index price_lists_name_key on public.price_lists (lower(name));
create unique index price_lists_single_standard on public.price_lists (is_standard) where is_standard;

insert into public.price_lists (name, description, is_standard)
values ('Standard rates', 'Default rates used when a customer has no specific rate.', true);

create table public.customers (
  id                  uuid primary key default gen_random_uuid(),
  customer_number     text not null unique,
  name                text not null check (length(trim(name)) between 1 and 160),
  customer_type       public.customer_type not null default 'commercial',
  email               text not null default '',
  phone               text not null default '',
  billing_line1       text not null default '',
  billing_line2       text not null default '',
  billing_city        text not null default '',
  billing_state       text not null default 'IN',
  billing_postal_code text not null default '',
  po_required         boolean not null default false,
  po_instructions     text not null default '',
  payment_terms       text not null default '',
  price_list_id       uuid references public.price_lists (id) on delete set null,
  tax_exempt          boolean not null default false,
  notes               text not null default '',
  active              boolean not null default true,
  is_sample           boolean not null default false,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  created_by          uuid references auth.users (id) on delete set null,
  updated_by          uuid references auth.users (id) on delete set null
);

create index customers_name_idx on public.customers (lower(name));
create index customers_active_idx on public.customers (active);

create or replace function private.assign_customer_number()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.customer_number is null or new.customer_number = '' then
    new.customer_number := private.next_document_number('customer');
  end if;
  new.created_by := coalesce(new.created_by, auth.uid());
  new.updated_by := auth.uid();
  return new;
end;
$$;

create or replace function private.stamp_updated_by()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.updated_by := auth.uid();
  new.updated_at := now();
  -- Identity columns are never editable.
  new.id := old.id;
  if tg_table_name = 'customers' then
    new.customer_number := old.customer_number;
    new.created_by := old.created_by;
    new.created_at := old.created_at;
  end if;
  return new;
end;
$$;

create trigger customers_number before insert on public.customers
  for each row execute function private.assign_customer_number();
create trigger customers_stamp before update on public.customers
  for each row execute function private.stamp_updated_by();
create trigger customers_audit after insert or update or delete on public.customers
  for each row execute function private.audit_row_change('customer');

create table public.customer_contacts (
  id           uuid primary key default gen_random_uuid(),
  customer_id  uuid not null references public.customers (id) on delete cascade,
  name         text not null check (length(trim(name)) between 1 and 120),
  title        text not null default '',
  email        text not null default '',
  phone        text not null default '',
  is_primary   boolean not null default false,
  is_billing   boolean not null default false,
  notes        text not null default '',
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index customer_contacts_customer_idx on public.customer_contacts (customer_id);
create unique index customer_contacts_one_primary on public.customer_contacts (customer_id) where is_primary and active;

create trigger customer_contacts_touch before update on public.customer_contacts
  for each row execute function private.touch_updated_at();
create trigger customer_contacts_audit after insert or update or delete on public.customer_contacts
  for each row execute function private.audit_row_change('customer_contact');

create table public.customer_sites (
  id           uuid primary key default gen_random_uuid(),
  customer_id  uuid not null references public.customers (id) on delete cascade,
  label        text not null check (length(trim(label)) between 1 and 120),
  line1        text not null check (length(trim(line1)) between 1 and 200),
  line2        text not null default '',
  city         text not null default '',
  state        text not null default 'IN',
  postal_code  text not null default '',
  directions   text not null default '',
  latitude     numeric(9, 6) check (latitude between -90 and 90),
  longitude    numeric(9, 6) check (longitude between -180 and 180),
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index customer_sites_customer_idx on public.customer_sites (customer_id);

create trigger customer_sites_touch before update on public.customer_sites
  for each row execute function private.touch_updated_at();
create trigger customer_sites_audit after insert or update or delete on public.customer_sites
  for each row execute function private.audit_row_change('customer_site');

-- -----------------------------------------------------------------------------
-- Materials and charge items
-- -----------------------------------------------------------------------------
create table public.materials (
  id                 uuid primary key default gen_random_uuid(),
  code               text check (code is null or code ~ '^[A-Za-z0-9._-]{1,30}$'),
  name               text not null check (length(trim(name)) between 1 and 120),
  description        text not null default '',
  default_unit_code  text not null references public.units_of_measure (code),
  taxable_default    boolean not null default true,
  active             boolean not null default true,
  is_sample          boolean not null default false,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create unique index materials_code_key on public.materials (upper(code)) where code is not null;
create unique index materials_name_key on public.materials (lower(name));

create trigger materials_touch before update on public.materials
  for each row execute function private.touch_updated_at();
create trigger materials_audit after insert or update or delete on public.materials
  for each row execute function private.audit_row_change('material');

-- Charges that are not a material: hauling, delivery, hourly service,
-- surcharges, discounts.
create table public.charge_items (
  id                  uuid primary key default gen_random_uuid(),
  code                text check (code is null or code ~ '^[A-Za-z0-9._-]{1,30}$'),
  name                text not null check (length(trim(name)) between 1 and 120),
  description         text not null default '',
  kind                public.charge_kind not null check (kind <> 'material'),
  calc_method         public.calc_method not null default 'per_unit',
  default_unit_code   text references public.units_of_measure (code),
  taxable_default     boolean not null default false,
  active              boolean not null default true,
  is_sample           boolean not null default false,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint charge_items_unit_required
    check (calc_method <> 'per_unit' or default_unit_code is not null)
);

create unique index charge_items_name_key on public.charge_items (lower(name));
create unique index charge_items_code_key on public.charge_items (upper(code)) where code is not null;

create trigger charge_items_touch before update on public.charge_items
  for each row execute function private.touch_updated_at();
create trigger charge_items_audit after insert or update or delete on public.charge_items
  for each row execute function private.audit_row_change('charge_item');

-- -----------------------------------------------------------------------------
-- Price list entries. A customer may reference a price list (customer-specific
-- or a shared tier). Resolution: customer's list → standard list → none.
-- -----------------------------------------------------------------------------
create table public.price_list_entries (
  id              uuid primary key default gen_random_uuid(),
  price_list_id   uuid not null references public.price_lists (id) on delete cascade,
  material_id     uuid references public.materials (id) on delete cascade,
  charge_item_id  uuid references public.charge_items (id) on delete cascade,
  unit_code       text references public.units_of_measure (code),
  rate_cents      bigint check (rate_cents between 0 and 100000000),
  percent_bp      integer check (percent_bp between 1 and 10000),
  effective_from  date not null default current_date,
  effective_to    date,
  notes           text not null default '',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint price_entry_item check (num_nonnulls(material_id, charge_item_id) = 1),
  constraint price_entry_value check (
    (rate_cents is not null and percent_bp is null and unit_code is not null)
    or (percent_bp is not null and rate_cents is null and unit_code is null)
  ),
  constraint price_entry_dates check (effective_to is null or effective_to >= effective_from)
);

create unique index price_list_entries_unique
  on public.price_list_entries (price_list_id, coalesce(material_id, charge_item_id), coalesce(unit_code, '%'), effective_from);
create index price_list_entries_material_idx on public.price_list_entries (material_id);
create index price_list_entries_charge_idx on public.price_list_entries (charge_item_id);

create trigger price_lists_touch before update on public.price_lists
  for each row execute function private.touch_updated_at();
create trigger price_lists_audit after insert or update or delete on public.price_lists
  for each row execute function private.audit_row_change('price_list');
create trigger price_list_entries_touch before update on public.price_list_entries
  for each row execute function private.touch_updated_at();
create trigger price_list_entries_audit after insert or update or delete on public.price_list_entries
  for each row execute function private.audit_row_change('price_list_entry');

-- Resolve the configured price for an item on a given date.
create or replace function private.resolve_price(
  p_customer_id uuid,
  p_material_id uuid,
  p_charge_item_id uuid,
  p_unit_code text,
  p_on date
)
returns table (rate_cents bigint, percent_bp integer, source text, entry_id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  with lists as (
    select c.price_list_id as list_id, 1 as priority, 'customer'::text as source
    from public.customers c
    join public.price_lists pl on pl.id = c.price_list_id and pl.active and not pl.is_standard
    where c.id = p_customer_id
    union all
    select pl.id, 2, 'standard'
    from public.price_lists pl
    where pl.is_standard and pl.active
  )
  select e.rate_cents, e.percent_bp, l.source, e.id
  from lists l
  join public.price_list_entries e on e.price_list_id = l.list_id
  where (p_material_id is not null and e.material_id = p_material_id
         or p_charge_item_id is not null and e.charge_item_id = p_charge_item_id)
    and e.unit_code is not distinct from p_unit_code
    and e.effective_from <= p_on
    and (e.effective_to is null or e.effective_to >= p_on)
  order by l.priority, e.effective_from desc
  limit 1
$$;

-- Effective prices for a customer on a date — used by the quote editor to
-- pre-fill rates. Same resolution order as private.resolve_price.
create or replace function public.effective_prices(p_customer_id uuid, p_on date)
returns table (
  material_id uuid,
  charge_item_id uuid,
  unit_code text,
  rate_cents bigint,
  percent_bp integer,
  source text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_permission('quotes.view');
  return query
  with lists as (
    select c.price_list_id as list_id, 1 as priority, 'customer'::text as src
    from public.customers c
    join public.price_lists pl on pl.id = c.price_list_id and pl.active and not pl.is_standard
    where c.id = p_customer_id
    union all
    select pl.id, 2, 'standard'
    from public.price_lists pl
    where pl.is_standard and pl.active
  ),
  ranked as (
    select e.material_id, e.charge_item_id, e.unit_code, e.rate_cents, e.percent_bp, l.src,
           row_number() over (
             partition by coalesce(e.material_id, e.charge_item_id), e.unit_code
             order by l.priority, e.effective_from desc
           ) as rn
    from lists l
    join public.price_list_entries e on e.price_list_id = l.list_id
    where e.effective_from <= p_on
      and (e.effective_to is null or e.effective_to >= p_on)
  )
  select r.material_id, r.charge_item_id, r.unit_code, r.rate_cents, r.percent_bp, r.src
  from ranked r
  where r.rn = 1;
end;
$$;

-- -----------------------------------------------------------------------------
-- RLS
-- -----------------------------------------------------------------------------
alter table public.units_of_measure enable row level security;
alter table public.price_lists enable row level security;
alter table public.customers enable row level security;
alter table public.customer_contacts enable row level security;
alter table public.customer_sites enable row level security;
alter table public.materials enable row level security;
alter table public.charge_items enable row level security;
alter table public.price_list_entries enable row level security;

-- Customers and their children
create policy customers_read on public.customers for select to authenticated
  using (private.has_permission('customers.view') or private.has_permission('quotes.view'));
create policy customers_insert on public.customers for insert to authenticated
  with check (private.has_permission('customers.edit'));
create policy customers_update on public.customers for update to authenticated
  using (private.has_permission('customers.edit'))
  with check (private.has_permission('customers.edit'));

create policy customer_contacts_read on public.customer_contacts for select to authenticated
  using (private.has_permission('customers.view') or private.has_permission('quotes.view'));
create policy customer_contacts_insert on public.customer_contacts for insert to authenticated
  with check (private.has_permission('customers.edit'));
create policy customer_contacts_update on public.customer_contacts for update to authenticated
  using (private.has_permission('customers.edit'))
  with check (private.has_permission('customers.edit'));

create policy customer_sites_read on public.customer_sites for select to authenticated
  using (private.has_permission('customers.view') or private.has_permission('quotes.view'));
create policy customer_sites_insert on public.customer_sites for insert to authenticated
  with check (private.has_permission('customers.edit'));
create policy customer_sites_update on public.customer_sites for update to authenticated
  using (private.has_permission('customers.edit'))
  with check (private.has_permission('customers.edit'));

-- Catalog
create policy units_read on public.units_of_measure for select to authenticated
  using (private.current_app_role() is not null);
create policy units_write on public.units_of_measure for insert to authenticated
  with check (private.has_permission('materials.edit'));
create policy units_update on public.units_of_measure for update to authenticated
  using (private.has_permission('materials.edit'))
  with check (private.has_permission('materials.edit'));

create policy materials_read on public.materials for select to authenticated
  using (private.has_permission('materials.view') or private.has_permission('quotes.view'));
create policy materials_insert on public.materials for insert to authenticated
  with check (private.has_permission('materials.edit'));
create policy materials_update on public.materials for update to authenticated
  using (private.has_permission('materials.edit'))
  with check (private.has_permission('materials.edit'));

create policy charge_items_read on public.charge_items for select to authenticated
  using (private.has_permission('materials.view') or private.has_permission('quotes.view'));
create policy charge_items_insert on public.charge_items for insert to authenticated
  with check (private.has_permission('materials.edit'));
create policy charge_items_update on public.charge_items for update to authenticated
  using (private.has_permission('materials.edit'))
  with check (private.has_permission('materials.edit'));

create policy price_lists_read on public.price_lists for select to authenticated
  using (private.has_permission('materials.view') or private.has_permission('quotes.view'));
create policy price_lists_insert on public.price_lists for insert to authenticated
  with check (private.has_permission('pricing.edit'));
create policy price_lists_update on public.price_lists for update to authenticated
  using (private.has_permission('pricing.edit'))
  with check (private.has_permission('pricing.edit'));

create policy price_entries_read on public.price_list_entries for select to authenticated
  using (private.has_permission('materials.view') or private.has_permission('quotes.view'));
create policy price_entries_insert on public.price_list_entries for insert to authenticated
  with check (private.has_permission('pricing.edit'));
create policy price_entries_update on public.price_list_entries for update to authenticated
  using (private.has_permission('pricing.edit'))
  with check (private.has_permission('pricing.edit'));
create policy price_entries_delete on public.price_list_entries for delete to authenticated
  using (private.has_permission('pricing.edit'));

-- -----------------------------------------------------------------------------
-- Grants
-- -----------------------------------------------------------------------------
revoke all on public.units_of_measure, public.price_lists, public.customers,
  public.customer_contacts, public.customer_sites, public.materials,
  public.charge_items, public.price_list_entries
  from anon, authenticated;

grant select, insert, update on public.units_of_measure, public.price_lists, public.customers,
  public.customer_contacts, public.customer_sites, public.materials,
  public.charge_items, public.price_list_entries
  to authenticated;
grant delete on public.price_list_entries to authenticated;

revoke execute on function public.effective_prices(uuid, date) from public, anon;
grant execute on function public.effective_prices(uuid, date) to authenticated;
grant execute on function private.resolve_price(uuid, uuid, uuid, text, date) to authenticated;
