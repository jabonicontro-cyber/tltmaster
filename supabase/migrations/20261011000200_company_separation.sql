-- =============================================================================
-- Company separation (tenant isolation)
--
-- * companies + company_memberships; Top Line Trucking becomes company #1
--   (fixed id 00000000-0000-4000-8000-000000000001) and owns all existing rows.
-- * company_id on every business table, with composite foreign keys so related
--   rows can never belong to different companies.
-- * Settings, document numbering, role grants, units and uniqueness rules are
--   per company.
-- * Roles move from profiles to memberships; profiles keep personal data only.
-- * Every SECURITY DEFINER function is re-written to resolve the caller's
--   company itself and to verify every referenced row belongs to it. No
--   function accepts a company id from the caller.
-- * RLS policies are rewritten as
--     company_id = (select private.current_company_id())
--     and (select private.has_permission('…'))
--   so both helpers are evaluated once per statement.
--
-- Safety: the whole file runs in one transaction (Supabase CLI / psql -1).
-- Existing rows are assigned to Top Line; a verification block at the end
-- aborts the migration if any count or ownership check fails. No rows are
-- deleted. profiles.role / profiles.active are dropped only after they have
-- been copied to company_memberships and verified.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 0. Record pre-migration counts for verification
-- -----------------------------------------------------------------------------
create temporary table tenancy_precheck as
select 'customers' as t, count(*) as n from public.customers
union all select 'customer_contacts', count(*) from public.customer_contacts
union all select 'customer_sites', count(*) from public.customer_sites
union all select 'materials', count(*) from public.materials
union all select 'charge_items', count(*) from public.charge_items
union all select 'price_lists', count(*) from public.price_lists
union all select 'price_list_entries', count(*) from public.price_list_entries
union all select 'quotes', count(*) from public.quotes
union all select 'quote_versions', count(*) from public.quote_versions
union all select 'quote_lines', count(*) from public.quote_lines
union all select 'quote_status_events', count(*) from public.quote_status_events
union all select 'documents', count(*) from public.documents
union all select 'email_deliveries', count(*) from public.email_deliveries
union all select 'orders', count(*) from public.orders
union all select 'order_lines', count(*) from public.order_lines
union all select 'order_status_events', count(*) from public.order_status_events
union all select 'audit_events', count(*) from public.audit_events
union all select 'units_of_measure', count(*) from public.units_of_measure
union all select 'role_permissions', count(*) from public.role_permissions
union all select 'document_sequences', count(*) from public.document_sequences
union all select 'company_settings', count(*) from public.company_settings
union all select 'profiles', count(*) from public.profiles;

create temporary table tenancy_quote_totals as
select id, total_cents, subtotal_cents, tax_cents, discount_cents from public.quote_versions;

-- -----------------------------------------------------------------------------
-- 1. Companies and memberships
-- -----------------------------------------------------------------------------
create table public.companies (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(trim(name)) between 1 and 160),
  slug        text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create trigger companies_touch before update on public.companies
  for each row execute function private.touch_updated_at();

insert into public.companies (id, name, slug)
select '00000000-0000-4000-8000-000000000001',
       coalesce((select nullif(trim(company_name), '') from public.company_settings limit 1), 'Top Line Trucking'),
       'top-line-trucking';

create table public.company_memberships (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies (id) on delete cascade,
  user_id     uuid not null references public.profiles (id) on delete cascade,
  role        public.app_role,            -- null = invited / waiting for a role
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (company_id, user_id)
);

create index company_memberships_user_idx on public.company_memberships (user_id);

create trigger company_memberships_touch before update on public.company_memberships
  for each row execute function private.touch_updated_at();

-- Copy every existing profile's role and active flag into a Top Line membership.
insert into public.company_memberships (company_id, user_id, role, active, created_at)
select '00000000-0000-4000-8000-000000000001', p.id, p.role, p.active, p.created_at
from public.profiles p;

-- Which company a user with several memberships is working in.
alter table public.profiles
  add column active_company_id uuid references public.companies (id) on delete set null;

-- Default role grants applied to new companies (global catalog, read-only).
create table public.role_permission_defaults (
  role        public.app_role not null,
  permission  text not null references public.permissions (code) on delete cascade,
  primary key (role, permission)
);
insert into public.role_permission_defaults (role, permission)
select role, permission from public.role_permissions;

-- -----------------------------------------------------------------------------
-- 2. company_id on every business table (existing rows → Top Line)
--    Adding a column with a constant default fills existing rows without
--    firing row triggers (append-only and immutability guards stay intact).
-- -----------------------------------------------------------------------------
do $$
declare
  t text;
  tables text[] := array[
    'company_settings', 'document_sequences', 'role_permissions', 'audit_events',
    'units_of_measure', 'price_lists', 'customers', 'customer_contacts', 'customer_sites',
    'materials', 'charge_items', 'price_list_entries', 'quotes', 'quote_versions',
    'quote_lines', 'quote_status_events', 'documents', 'email_deliveries', 'orders',
    'order_lines', 'order_status_events'];
begin
  foreach t in array tables loop
    execute format(
      'alter table public.%I add column company_id uuid not null default %L references public.companies (id)',
      t, '00000000-0000-4000-8000-000000000001');
  end loop;
end
$$;

-- Audit rows may legitimately have no company (e.g. a profile created by
-- sign-up); they are then visible to nobody through RLS.
alter table public.audit_events alter column company_id drop not null;

-- -----------------------------------------------------------------------------
-- 3. Per-company keys: settings, numbering, role grants, units
-- -----------------------------------------------------------------------------
alter table public.company_settings drop constraint company_settings_pkey;
alter table public.company_settings drop column id;
alter table public.company_settings add primary key (company_id);

alter table public.document_sequences drop constraint document_sequences_pkey;
alter table public.document_sequences add primary key (company_id, key);

alter table public.role_permissions drop constraint role_permissions_pkey;
alter table public.role_permissions add primary key (company_id, role, permission);

-- Units: drop the single-column FKs that reference units(code) first.
alter table public.materials drop constraint materials_default_unit_code_fkey;
alter table public.charge_items drop constraint charge_items_default_unit_code_fkey;
alter table public.price_list_entries drop constraint price_list_entries_unit_code_fkey;
alter table public.quote_lines drop constraint quote_lines_unit_code_fkey;
alter table public.order_lines drop constraint order_lines_unit_code_fkey;
alter table public.units_of_measure drop constraint units_of_measure_pkey;
alter table public.units_of_measure add primary key (company_id, code);

-- -----------------------------------------------------------------------------
-- 4. Uniqueness per company
-- -----------------------------------------------------------------------------
alter table public.customers drop constraint customers_customer_number_key;
alter table public.customers add constraint customers_company_number_key unique (company_id, customer_number);
alter table public.quotes drop constraint quotes_quote_number_key;
alter table public.quotes add constraint quotes_company_number_key unique (company_id, quote_number);
alter table public.orders drop constraint orders_order_number_key;
alter table public.orders add constraint orders_company_number_key unique (company_id, order_number);

drop index public.price_lists_name_key;
drop index public.price_lists_single_standard;
drop index public.materials_code_key;
drop index public.materials_name_key;
drop index public.charge_items_name_key;
drop index public.charge_items_code_key;
create unique index price_lists_name_key on public.price_lists (company_id, lower(name));
create unique index price_lists_single_standard on public.price_lists (company_id) where is_standard;
create unique index materials_code_key on public.materials (company_id, upper(code)) where code is not null;
create unique index materials_name_key on public.materials (company_id, lower(name));
create unique index charge_items_name_key on public.charge_items (company_id, lower(name));
create unique index charge_items_code_key on public.charge_items (company_id, upper(code)) where code is not null;

-- -----------------------------------------------------------------------------
-- 5. Same-company relations: composite keys (company_id, id) and composite FKs
-- -----------------------------------------------------------------------------
alter table public.price_lists        add constraint price_lists_company_id_key        unique (company_id, id);
alter table public.customers          add constraint customers_company_id_key          unique (company_id, id);
alter table public.customer_contacts  add constraint customer_contacts_company_id_key  unique (company_id, id);
alter table public.customer_sites     add constraint customer_sites_company_id_key     unique (company_id, id);
alter table public.materials          add constraint materials_company_id_key          unique (company_id, id);
alter table public.charge_items       add constraint charge_items_company_id_key       unique (company_id, id);
alter table public.quotes             add constraint quotes_company_id_key             unique (company_id, id);
alter table public.quote_versions     add constraint quote_versions_company_id_key     unique (company_id, id);
alter table public.quote_lines        add constraint quote_lines_company_id_key        unique (company_id, id);
alter table public.documents          add constraint documents_company_id_key          unique (company_id, id);
alter table public.orders             add constraint orders_company_id_key             unique (company_id, id);

-- Replace single-column FKs between business tables.
alter table public.customers drop constraint customers_price_list_id_fkey;
alter table public.customers add constraint customers_price_list_fk
  foreign key (company_id, price_list_id) references public.price_lists (company_id, id) on delete set null (price_list_id);

alter table public.customer_contacts drop constraint customer_contacts_customer_id_fkey;
alter table public.customer_contacts add constraint customer_contacts_customer_fk
  foreign key (company_id, customer_id) references public.customers (company_id, id) on delete cascade;
alter table public.customer_sites drop constraint customer_sites_customer_id_fkey;
alter table public.customer_sites add constraint customer_sites_customer_fk
  foreign key (company_id, customer_id) references public.customers (company_id, id) on delete cascade;

alter table public.materials add constraint materials_unit_fk
  foreign key (company_id, default_unit_code) references public.units_of_measure (company_id, code);
alter table public.charge_items add constraint charge_items_unit_fk
  foreign key (company_id, default_unit_code) references public.units_of_measure (company_id, code);

alter table public.price_list_entries drop constraint price_list_entries_price_list_id_fkey;
alter table public.price_list_entries drop constraint price_list_entries_material_id_fkey;
alter table public.price_list_entries drop constraint price_list_entries_charge_item_id_fkey;
alter table public.price_list_entries
  add constraint price_list_entries_price_list_fk foreign key (company_id, price_list_id) references public.price_lists (company_id, id) on delete cascade,
  add constraint price_list_entries_material_fk foreign key (company_id, material_id) references public.materials (company_id, id) on delete cascade,
  add constraint price_list_entries_charge_item_fk foreign key (company_id, charge_item_id) references public.charge_items (company_id, id) on delete cascade,
  add constraint price_list_entries_unit_fk foreign key (company_id, unit_code) references public.units_of_measure (company_id, code);

alter table public.quotes drop constraint quotes_customer_id_fkey;
alter table public.quotes drop constraint quotes_current_version_fk;
alter table public.quotes drop constraint quotes_accepted_version_fk;
alter table public.quotes
  add constraint quotes_customer_fk foreign key (company_id, customer_id) references public.customers (company_id, id),
  add constraint quotes_current_version_fk foreign key (company_id, current_version_id)
    references public.quote_versions (company_id, id) deferrable initially deferred,
  add constraint quotes_accepted_version_fk foreign key (company_id, accepted_version_id)
    references public.quote_versions (company_id, id) deferrable initially deferred;

alter table public.quote_versions drop constraint quote_versions_quote_id_fkey;
alter table public.quote_versions drop constraint quote_versions_contact_id_fkey;
alter table public.quote_versions drop constraint quote_versions_site_id_fkey;
alter table public.quote_versions
  add constraint quote_versions_quote_fk foreign key (company_id, quote_id) references public.quotes (company_id, id) on delete cascade,
  add constraint quote_versions_contact_fk foreign key (company_id, contact_id)
    references public.customer_contacts (company_id, id) on delete set null (contact_id),
  add constraint quote_versions_site_fk foreign key (company_id, site_id)
    references public.customer_sites (company_id, id) on delete set null (site_id);

alter table public.quote_lines drop constraint quote_lines_quote_version_id_fkey;
alter table public.quote_lines drop constraint quote_lines_material_id_fkey;
alter table public.quote_lines drop constraint quote_lines_charge_item_id_fkey;
alter table public.quote_lines
  add constraint quote_lines_version_fk foreign key (company_id, quote_version_id) references public.quote_versions (company_id, id) on delete cascade,
  add constraint quote_lines_material_fk foreign key (company_id, material_id) references public.materials (company_id, id),
  add constraint quote_lines_charge_item_fk foreign key (company_id, charge_item_id) references public.charge_items (company_id, id),
  add constraint quote_lines_unit_fk foreign key (company_id, unit_code) references public.units_of_measure (company_id, code);

alter table public.quote_status_events drop constraint quote_status_events_quote_id_fkey;
alter table public.quote_status_events drop constraint quote_status_events_version_id_fkey;
alter table public.quote_status_events
  add constraint quote_status_events_quote_fk foreign key (company_id, quote_id) references public.quotes (company_id, id) on delete cascade,
  add constraint quote_status_events_version_fk foreign key (company_id, version_id)
    references public.quote_versions (company_id, id) on delete set null (version_id);

alter table public.documents drop constraint documents_quote_version_id_fkey;
alter table public.documents add constraint documents_version_fk
  foreign key (company_id, quote_version_id) references public.quote_versions (company_id, id) on delete cascade;

alter table public.email_deliveries drop constraint email_deliveries_quote_id_fkey;
alter table public.email_deliveries drop constraint email_deliveries_quote_version_id_fkey;
alter table public.email_deliveries drop constraint email_deliveries_document_id_fkey;
alter table public.email_deliveries
  add constraint email_deliveries_quote_fk foreign key (company_id, quote_id) references public.quotes (company_id, id) on delete cascade,
  add constraint email_deliveries_version_fk foreign key (company_id, quote_version_id) references public.quote_versions (company_id, id) on delete cascade,
  add constraint email_deliveries_document_fk foreign key (company_id, document_id)
    references public.documents (company_id, id) on delete set null (document_id);

alter table public.orders drop constraint orders_customer_id_fkey;
alter table public.orders drop constraint orders_source_quote_id_fkey;
alter table public.orders drop constraint orders_source_quote_version_id_fkey;
alter table public.orders drop constraint orders_site_id_fkey;
alter table public.orders
  add constraint orders_customer_fk foreign key (company_id, customer_id) references public.customers (company_id, id),
  add constraint orders_source_quote_fk foreign key (company_id, source_quote_id) references public.quotes (company_id, id) on delete restrict,
  add constraint orders_source_version_fk foreign key (company_id, source_quote_version_id)
    references public.quote_versions (company_id, id) on delete restrict,
  add constraint orders_site_fk foreign key (company_id, site_id)
    references public.customer_sites (company_id, id) on delete set null (site_id);

alter table public.order_lines drop constraint order_lines_order_id_fkey;
alter table public.order_lines drop constraint order_lines_source_quote_line_id_fkey;
alter table public.order_lines drop constraint order_lines_material_id_fkey;
alter table public.order_lines drop constraint order_lines_charge_item_id_fkey;
alter table public.order_lines
  add constraint order_lines_order_fk foreign key (company_id, order_id) references public.orders (company_id, id) on delete cascade,
  add constraint order_lines_source_line_fk foreign key (company_id, source_quote_line_id)
    references public.quote_lines (company_id, id) on delete restrict,
  add constraint order_lines_material_fk foreign key (company_id, material_id) references public.materials (company_id, id),
  add constraint order_lines_charge_item_fk foreign key (company_id, charge_item_id) references public.charge_items (company_id, id),
  add constraint order_lines_unit_fk foreign key (company_id, unit_code) references public.units_of_measure (company_id, code);

alter table public.order_status_events drop constraint order_status_events_order_id_fkey;
alter table public.order_status_events add constraint order_status_events_order_fk
  foreign key (company_id, order_id) references public.orders (company_id, id) on delete cascade;

-- Indexes for company filters not already led by company_id.
create index audit_events_company_idx on public.audit_events (company_id, occurred_at desc);
create index quote_status_events_company_idx on public.quote_status_events (company_id);
create index email_deliveries_company_idx on public.email_deliveries (company_id);
create index order_lines_company_idx on public.order_lines (company_id);
create index order_status_events_company_idx on public.order_status_events (company_id);
create index price_list_entries_company_idx on public.price_list_entries (company_id);

-- -----------------------------------------------------------------------------
-- 6. A row can never move to another company.
-- -----------------------------------------------------------------------------
create or replace function private.forbid_company_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.company_id is distinct from old.company_id then
    raise exception 'Records cannot be moved to another company.' using errcode = '42501';
  end if;
  return new;
end;
$$;

do $$
declare
  t text;
begin
  foreach t in array array[
    'company_settings', 'document_sequences', 'role_permissions', 'audit_events',
    'units_of_measure', 'price_lists', 'customers', 'customer_contacts', 'customer_sites',
    'materials', 'charge_items', 'price_list_entries', 'quotes', 'quote_versions',
    'quote_lines', 'quote_status_events', 'documents', 'email_deliveries', 'orders',
    'order_lines', 'order_status_events', 'company_memberships'] loop
    execute format(
      'create trigger a_company_guard before update of company_id on public.%I for each row execute function private.forbid_company_change()', t);
  end loop;
end
$$;

-- Membership changes are audited like other access changes.
create trigger company_memberships_audit
  after insert or update or delete on public.company_memberships
  for each row execute function private.audit_row_change('membership');

-- =============================================================================
-- 7. Company and permission helpers
-- =============================================================================

-- The company the signed-in user is working in. Only active memberships with
-- a role in an active company count. With several memberships,
-- profiles.active_company_id picks one; otherwise the oldest membership wins.
-- Never derived from anything the client sends.
create or replace function private.current_company_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.company_id
  from public.company_memberships m
  join public.companies c on c.id = m.company_id and c.active
  join public.profiles p on p.id = m.user_id
  where m.user_id = auth.uid()
    and m.active
    and m.role is not null
  order by (m.company_id = p.active_company_id) desc nulls last, m.created_at, m.company_id
  limit 1
$$;

create or replace function private.current_app_role()
returns public.app_role
language sql
stable
security definer
set search_path = ''
as $$
  select m.role
  from public.company_memberships m
  where m.user_id = auth.uid()
    and m.company_id = private.current_company_id()
$$;

create or replace function private.has_permission(p_permission text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.company_memberships m
    join public.role_permissions rp
      on rp.company_id = m.company_id and rp.role = m.role
    where m.user_id = auth.uid()
      and m.company_id = private.current_company_id()
      and m.active
      and rp.permission = p_permission
  )
$$;

-- True when the given user belongs (in any state) to the caller's company.
create or replace function private.is_company_member(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.company_memberships m
    where m.user_id = p_user_id and m.company_id = private.current_company_id()
  )
$$;

-- Raise unless the caller has a company (used by functions that need one).
create or replace function private.require_company()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.current_company_id();
begin
  if v_company is null then
    raise exception 'You do not have access to any company.' using errcode = '42501';
  end if;
  return v_company;
end;
$$;

create or replace function public.my_access()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with cur as (select private.current_company_id() as company_id),
  m as (
    -- The current company's membership, or (for users waiting for access) any membership.
    select m.*
    from public.company_memberships m, cur
    where m.user_id = auth.uid()
    order by (m.company_id = cur.company_id) desc nulls last, m.created_at
    limit 1
  )
  select jsonb_build_object(
    'user_id', p.id,
    'email', p.email,
    'full_name', p.full_name,
    'company_id', cur.company_id,
    'company_name', (select c.name from public.companies c where c.id = cur.company_id),
    'role', case when cur.company_id is not null then m.role end,
    'active', coalesce(m.active, true) and (m.company_id is null or exists (select 1 from public.companies c where c.id = m.company_id and c.active)),
    'membership_count', (select count(*) from public.company_memberships x where x.user_id = p.id and x.active and x.role is not null),
    'permissions', coalesce(
      (select jsonb_agg(rp.permission order by rp.permission)
       from public.role_permissions rp
       where cur.company_id is not null and rp.company_id = cur.company_id and rp.role = m.role and m.active),
      '[]'::jsonb)
  )
  from public.profiles p
  cross join cur
  left join m on true
  where p.id = auth.uid()
$$;

-- =============================================================================
-- 8. Audit helpers (company taken from the row, else the caller's company)
-- =============================================================================
create or replace function private.log_event(
  p_action text,
  p_entity_type text,
  p_entity_id uuid,
  p_summary text,
  p_details jsonb default '{}'::jsonb
)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.audit_events (company_id, actor_id, action, entity_type, entity_id, summary, details)
  values (private.current_company_id(), auth.uid(), p_action, p_entity_type, p_entity_id,
          coalesce(p_summary, ''), coalesce(p_details, '{}'::jsonb));
$$;

create or replace function private.audit_row_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old jsonb;
  v_new jsonb;
  v_changes jsonb := '{}'::jsonb;
  v_key text;
  v_entity_id uuid;
  v_action text;
  v_company uuid;
  v_ignored constant text[] := array['updated_at', 'created_at'];
begin
  if tg_op = 'INSERT' then
    v_new := to_jsonb(new);
    v_action := 'created';
    v_changes := v_new - v_ignored;
  elsif tg_op = 'UPDATE' then
    v_old := to_jsonb(old);
    v_new := to_jsonb(new);
    v_action := 'updated';
    for v_key in select jsonb_object_keys(v_new) loop
      if v_key <> all (v_ignored) and (v_old -> v_key) is distinct from (v_new -> v_key) then
        v_changes := v_changes || jsonb_build_object(v_key, jsonb_build_object('from', v_old -> v_key, 'to', v_new -> v_key));
      end if;
    end loop;
    if v_changes = '{}'::jsonb then
      return new;
    end if;
  else
    v_old := to_jsonb(old);
    v_action := 'deleted';
    v_changes := v_old - v_ignored;
  end if;

  v_entity_id := nullif(coalesce(v_new ->> 'id', v_old ->> 'id'), '')::uuid;
  v_company := coalesce(nullif(coalesce(v_new ->> 'company_id', v_old ->> 'company_id'), '')::uuid,
                        private.current_company_id());

  insert into public.audit_events (company_id, actor_id, action, entity_type, entity_id, summary, details)
  values (
    v_company,
    auth.uid(),
    tg_argv[0] || '.' || v_action,
    tg_argv[0],
    v_entity_id,
    initcap(replace(tg_argv[0], '_', ' ')) || ' ' || v_action,
    v_changes
  );

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

-- =============================================================================
-- 9. Per-company settings and numbering
-- =============================================================================
drop function private.business_today();
drop function private.business_timezone();
drop function private.next_document_number(text);

create or replace function private.business_timezone(p_company_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select timezone from public.company_settings where company_id = p_company_id), 'America/Chicago')
$$;

create or replace function private.business_today(p_company_id uuid)
returns date
language sql
stable
security definer
set search_path = ''
as $$
  select (now() at time zone private.business_timezone(p_company_id))::date
$$;

-- Internal only (not executable by clients): callers pass a company they have
-- already verified (the row's own company or the caller's current company).
create or replace function private.next_document_number(p_company_id uuid, p_key text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_seq   public.document_sequences%rowtype;
  v_year  integer := extract(year from (now() at time zone private.business_timezone(p_company_id)))::integer;
  v_value bigint;
begin
  select * into v_seq from public.document_sequences
  where company_id = p_company_id and key = p_key
  for update;
  if not found then
    raise exception 'Unknown document sequence % for this company', p_key;
  end if;

  if v_seq.include_year and v_seq.current_year is distinct from v_year then
    v_value := 1;
  else
    v_value := v_seq.next_value;
  end if;

  perform set_config('tlt.number_allocation', 'on', true);
  update public.document_sequences
     set next_value = v_value + 1,
         current_year = v_year
   where company_id = p_company_id and key = p_key;
  perform set_config('tlt.number_allocation', 'off', true);

  return v_seq.prefix
      || case when v_seq.include_year then v_year::text || '-' else '' end
      || lpad(v_value::text, v_seq.pad, '0');
end;
$$;

create or replace function private.assign_customer_number()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- new.company_id is the column default (caller's company) or explicit. App
  -- users may only create customers in their own company; refuse before a
  -- number is allocated. (Operators/seed run without auth.uid().)
  if auth.uid() is not null
     and (new.company_id is null or new.company_id is distinct from private.current_company_id()) then
    raise exception 'You do not have permission to create customers for this company.' using errcode = '42501';
  end if;
  if new.customer_number is null or new.customer_number = '' then
    new.customer_number := private.next_document_number(new.company_id, 'customer');
  end if;
  new.created_by := coalesce(new.created_by, auth.uid());
  new.updated_by := auth.uid();
  return new;
end;
$$;

-- =============================================================================
-- 10. Creating a company (operators only — not executable by app users)
-- =============================================================================
create or replace function private.create_company(p_name text, p_slug text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  insert into public.companies (name, slug) values (trim(p_name), p_slug) returning id into v_id;

  insert into public.company_settings (company_id, company_name, default_quote_terms, quote_footer_note)
  values (v_id, trim(p_name),
    'Pricing is based on the quantities and delivery location shown. Actual charges are based on delivered quantities. '
    || 'Delivery times are estimates and depend on weather, site access and material availability. '
    || 'Customer is responsible for providing safe, accessible dump/delivery locations. '
    || 'This quote is valid until the expiration date shown.',
    'Thank you for the opportunity to quote this work.');

  insert into public.document_sequences (company_id, key, label, prefix, include_year, pad) values
    (v_id, 'customer', 'Customer numbers', 'C-', false, 5),
    (v_id, 'quote',    'Quote numbers',    'Q-', true,  4),
    (v_id, 'order',    'Order numbers',    'O-', true,  4),
    (v_id, 'ticket',   'Ticket numbers',   'T-', true,  5);

  insert into public.role_permissions (company_id, role, permission)
  select v_id, role, permission from public.role_permission_defaults;

  insert into public.units_of_measure (company_id, code, label, abbreviation, sort_order) values
    (v_id, 'ton',   'Tons',        'ton',   10),
    (v_id, 'load',  'Loads',       'load',  20),
    (v_id, 'cu_yd', 'Cubic yards', 'cu yd', 30),
    (v_id, 'hour',  'Hours',       'hr',    40),
    (v_id, 'mile',  'Miles',       'mi',    50),
    (v_id, 'day',   'Days',        'day',   60),
    (v_id, 'each',  'Each',        'ea',    70);

  insert into public.price_lists (company_id, name, description, is_standard)
  values (v_id, 'Standard rates', 'Default rates used when a customer has no specific rate.', true);

  return v_id;
end;
$$;

-- =============================================================================
-- 11. User administration (always within the caller's company)
-- =============================================================================
create or replace function public.set_user_access(
  p_user_id uuid,
  p_role public.app_role,
  p_active boolean,
  p_full_name text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid;
  v_remaining_owners integer;
begin
  perform private.require_permission('users.manage');
  v_company := private.require_company();

  if p_full_name is null or length(trim(p_full_name)) = 0 or length(p_full_name) > 120 then
    raise exception 'Name is required (120 characters max).';
  end if;

  update public.company_memberships
     set role = p_role,
         active = p_active
   where company_id = v_company and user_id = p_user_id;
  if not found then
    raise exception 'User not found.';
  end if;

  -- A profile is shared across companies: only rename people who belong to
  -- this company alone.
  update public.profiles
     set full_name = trim(p_full_name)
   where id = p_user_id
     and not exists (select 1 from public.company_memberships m
                     where m.user_id = p_user_id and m.company_id <> v_company);

  select count(*) into v_remaining_owners
  from public.company_memberships
  where company_id = v_company and role = 'owner' and active;

  if v_remaining_owners = 0 then
    raise exception 'At least one active owner account is required.';
  end if;
end;
$$;

-- Adds an existing account (e.g. just invited) to the caller's company.
create or replace function public.add_company_member(p_user_id uuid, p_role public.app_role, p_full_name text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid;
begin
  perform private.require_permission('users.manage');
  v_company := private.require_company();

  if not exists (select 1 from public.profiles where id = p_user_id) then
    raise exception 'User not found.';
  end if;

  insert into public.company_memberships (company_id, user_id, role, active)
  values (v_company, p_user_id, p_role, true);

  update public.profiles
     set full_name = trim(p_full_name)
   where id = p_user_id
     and length(trim(coalesce(p_full_name, ''))) between 1 and 120
     and not exists (select 1 from public.company_memberships m
                     where m.user_id = p_user_id and m.company_id <> v_company);
exception
  when unique_violation then
    raise exception 'This user is already a member of your company.';
end;
$$;

create or replace function public.set_role_permission(
  p_role public.app_role,
  p_permission text,
  p_granted boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid;
begin
  perform private.require_permission('users.manage');
  v_company := private.require_company();

  if p_role = 'owner' then
    raise exception 'Owner permissions cannot be changed.';
  end if;
  if not exists (select 1 from public.permissions where code = p_permission) then
    raise exception 'Unknown permission.';
  end if;

  if p_granted then
    insert into public.role_permissions (company_id, role, permission)
    values (v_company, p_role, p_permission)
    on conflict do nothing;
  else
    delete from public.role_permissions
     where company_id = v_company and role = p_role and permission = p_permission;
  end if;
end;
$$;

-- Names of people in the caller's company for history views. Email addresses
-- only for users who manage users.
create or replace function public.user_directory()
returns table (id uuid, full_name text, email text)
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

-- =============================================================================
-- 12. Pricing lookups (scoped to the customer's company, which must be the
--     caller's company)
-- =============================================================================
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
  with cust as (
    select c.id, c.company_id, c.price_list_id from public.customers c where c.id = p_customer_id
  ),
  lists as (
    select pl.id as list_id, 1 as priority, 'customer'::text as source
    from cust
    join public.price_lists pl
      on pl.company_id = cust.company_id and pl.id = cust.price_list_id and pl.active and not pl.is_standard
    union all
    select pl.id, 2, 'standard'
    from cust
    join public.price_lists pl on pl.company_id = cust.company_id and pl.is_standard and pl.active
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
declare
  v_company uuid;
begin
  perform private.require_permission('quotes.view');
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
$$;

-- =============================================================================
-- 13. Quote / order helpers
-- =============================================================================
create or replace function private.record_status_change(
  p_quote_id uuid,
  p_version_id uuid,
  p_from public.quote_status,
  p_to public.quote_status,
  p_note text
)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.quote_status_events (company_id, quote_id, version_id, from_status, to_status, note, actor_id)
  select q.company_id, q.id, p_version_id, p_from, p_to, coalesce(p_note, ''), auth.uid()
  from public.quotes q
  where q.id = p_quote_id;
$$;

create or replace function private.purge_sample_quote_orders()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if current_setting('tlt.sample_purge', true) = 'on' then
    delete from public.orders where company_id = old.company_id and source_quote_id = old.id;
  end if;
  return old;
end;
$$;

create or replace function public.sample_data_counts()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with cur as (select private.current_company_id() as id)
  select jsonb_build_object(
    'customers', (select count(*) from public.customers, cur where company_id = cur.id and is_sample),
    'materials', (select count(*) from public.materials, cur where company_id = cur.id and is_sample),
    'charge_items', (select count(*) from public.charge_items, cur where company_id = cur.id and is_sample),
    'price_lists', (select count(*) from public.price_lists, cur where company_id = cur.id and is_sample),
    'quotes', (select count(*) from public.quotes, cur where company_id = cur.id and is_sample),
    'orders', (select count(*) from public.orders, cur where company_id = cur.id and is_sample)
  )
  from cur
  where cur.id is not null
$$;

-- =============================================================================
-- 14. Quote, order and sample-data functions: every lookup is restricted to the
--     caller's company; every insert carries the verified company id.
-- =============================================================================
CREATE OR REPLACE FUNCTION public.save_quote_draft(p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_quote        public.quotes%rowtype;
  v_version      public.quote_versions%rowtype;
  v_customer     public.customers%rowtype;
  v_is_new       boolean := (p_payload ->> 'quote_id') is null;
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
  v_quote_date   date;
  v_valid_until  date;
  v_tax_bp       integer;
  v_site_id      uuid;
  v_contact_id   uuid;
  v_item_ok      boolean;
  v_company      uuid;
begin
  perform private.require_permission('quotes.edit');
  v_company := private.require_company();

  if jsonb_typeof(v_lines) <> 'array' then
    raise exception 'Lines must be a list.';
  end if;
  if jsonb_array_length(v_lines) > 200 then
    raise exception 'A quote can have at most 200 lines.';
  end if;

  select * into v_customer from public.customers
  where id = (p_payload ->> 'customer_id')::uuid and company_id = v_company;
  if not found then
    raise exception 'Select a customer for this quote.';
  end if;

  -- Locate / create quote and draft version --------------------------------
  if v_is_new then
    if not v_customer.active then
      raise exception 'Customer % is archived. Reactivate the customer before quoting.', v_customer.name;
    end if;

    insert into public.quotes (company_id, quote_number, customer_id, status, is_sample, created_by)
    values (v_company, private.next_document_number(v_company, 'quote'), v_customer.id, 'draft', v_customer.is_sample, auth.uid())
    returning * into v_quote;

    insert into public.quote_versions (company_id, quote_id, version_no, quote_date, valid_until, created_by)
    values (v_company, v_quote.id, 1, private.business_today(v_company),
            private.business_today(v_company) + (select quote_validity_days from public.company_settings where company_id = v_company),
            auth.uid())
    returning * into v_version;

    update public.quotes set current_version_id = v_version.id where id = v_quote.id;

    perform private.record_status_change(v_quote.id, v_version.id, null, 'draft', 'Quote created');
  else
    select * into v_quote from public.quotes
    where id = (p_payload ->> 'quote_id')::uuid and company_id = v_company for update;
    if not found then
      raise exception 'Quote not found.';
    end if;
    if v_quote.status <> 'draft' then
      raise exception 'Quote % is %. Only drafts can be edited — create a revision to make changes.',
        v_quote.quote_number, v_quote.status;
    end if;

    select * into v_version from public.quote_versions where id = v_quote.current_version_id for update;
    if v_version.locked_at is not null then
      raise exception 'This version has been issued and cannot be changed. Create a revision instead.';
    end if;
    if (p_payload ->> 'expected_edit_seq') is not null
       and (p_payload ->> 'expected_edit_seq')::integer <> v_version.edit_seq then
      raise exception 'This quote was changed by someone else while you were editing. Reload to see the latest version.'
        using errcode = 'PT409';
    end if;

    if v_customer.id <> v_quote.customer_id then
      if exists (select 1 from public.quote_versions where quote_id = v_quote.id and locked_at is not null) then
        raise exception 'The customer cannot be changed after the quote has been issued.';
      end if;
      update public.quotes set customer_id = v_customer.id where id = v_quote.id;
    end if;
  end if;

  -- Header fields -------------------------------------------------------------
  v_quote_date := coalesce((p_payload ->> 'quote_date')::date, v_version.quote_date);
  v_valid_until := coalesce((p_payload ->> 'valid_until')::date, v_version.valid_until);
  if v_valid_until < v_quote_date then
    raise exception 'The expiration date must be on or after the quote date.';
  end if;

  v_tax_bp := coalesce((p_payload ->> 'tax_rate_bp')::integer, 0);
  if v_tax_bp < 0 or v_tax_bp > 2500 then
    raise exception 'Tax rate must be between 0%% and 25%%.';
  end if;
  if v_customer.tax_exempt then
    v_tax_bp := 0;
  end if;

  v_contact_id := nullif(p_payload ->> 'contact_id', '')::uuid;
  if v_contact_id is not null and not exists (
    select 1 from public.customer_contacts where id = v_contact_id and customer_id = v_customer.id
  ) then
    raise exception 'The selected contact does not belong to this customer.';
  end if;

  v_site_id := nullif(p_payload ->> 'site_id', '')::uuid;
  if v_site_id is not null and not exists (
    select 1 from public.customer_sites where id = v_site_id and customer_id = v_customer.id
  ) then
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
      v_company,
      v_customer.id,
      coalesce(nullif(private.clean_text(p_payload ->> 'site_label', 120, 'Job site name'), ''),
               private.clean_text(p_payload ->> 'site_line1', 200, 'Job site address')),
      private.clean_text(p_payload ->> 'site_line1', 200, 'Job site address'),
      private.clean_text(p_payload ->> 'site_line2', 200, 'Job site address line 2'),
      private.clean_text(p_payload ->> 'site_city', 80, 'Job site city'),
      private.clean_text(p_payload ->> 'site_state', 2, 'Job site state'),
      private.clean_text(p_payload ->> 'site_postal_code', 10, 'Job site ZIP')
    )
    returning id into v_site_id;
  end if;

  update public.quote_versions set
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
    quote_date       = v_quote_date,
    valid_until      = v_valid_until,
    project_name     = private.clean_text(p_payload ->> 'project_name', 160, 'Project name'),
    customer_po      = private.clean_text(p_payload ->> 'customer_po', 60, 'Customer PO'),
    job_instructions = private.clean_text(p_payload ->> 'job_instructions', 4000, 'Job instructions'),
    terms            = private.clean_text(p_payload ->> 'terms', 8000, 'Terms'),
    internal_notes   = private.clean_text(p_payload ->> 'internal_notes', 4000, 'Internal notes'),
    tax_rate_bp      = v_tax_bp,
    edit_seq         = edit_seq + case when v_is_new then 0 else 1 end
  where id = v_version.id
  returning * into v_version;

  -- Lines -------------------------------------------------------------------
  delete from public.quote_lines where quote_version_id = v_version.id;

  -- Percentage lines are calculated on the sum of the per-unit, non-discount
  -- lines. Compute that base first so lines keep the order the user entered.
  -- (Malformed values are rejected with a clear message in the loop below.)
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
      from private.resolve_price(v_customer.id, v_material_id, v_charge_id, v_unit_code, v_quote_date) r;
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
      from private.resolve_price(v_customer.id, null, v_charge_id, null, v_quote_date) r;
    end if;

    -- Determine price source and whether an override is involved.
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

    insert into public.quote_lines (
      company_id, quote_version_id, line_no, kind, calc_method, material_id, charge_item_id, description,
      unit_code, unit_label, quantity, unit_rate_cents, percent_bp, catalog_rate_cents,
      catalog_percent_bp, price_source, taxable, amount_cents)
    values (
      v_company, v_version.id, v_line_no, v_kind, v_method, v_material_id, v_charge_id, v_desc,
      v_unit_code, coalesce(v_unit_label, ''), v_quantity, v_rate, v_percent, v_cat_rate,
      v_cat_percent, v_source, v_taxable, v_amount);
    v_unit_label := null;
  end loop;

  if v_needs_override and not private.has_permission('pricing.override') then
    raise exception 'This quote contains a discount or a rate that differs from the configured price. '
      'You do not have permission to override pricing.' using errcode = '42501';
  end if;

  perform private.recompute_quote_totals(v_version.id);
  select * into v_version from public.quote_versions where id = v_version.id;

  perform private.log_event(
    case when v_is_new then 'quote.created' else 'quote.updated' end,
    'quote', v_quote.id,
    format('%s %s (v%s): total %s', v_quote.quote_number,
           case when v_is_new then 'created' else 'saved' end,
           v_version.version_no, to_char(v_version.total_cents / 100.0, 'FM999,999,990.00')),
    jsonb_build_object('version_id', v_version.id, 'edit_seq', v_version.edit_seq,
                       'total_cents', v_version.total_cents,
                       'line_count', jsonb_array_length(v_lines),
                       'pricing_override', v_needs_override));

  return jsonb_build_object(
    'quote_id', v_quote.id,
    'quote_number', v_quote.quote_number,
    'version_id', v_version.id,
    'version_no', v_version.version_no,
    'edit_seq', v_version.edit_seq,
    'total_cents', v_version.total_cents);
end;
$function$
;

CREATE OR REPLACE FUNCTION private.issue_current_version(p_quote_id uuid, p_expected_edit_seq integer)
 RETURNS quote_versions
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_quote   public.quotes%rowtype;
  v_version public.quote_versions%rowtype;
  v_lines   integer;
  v_company uuid := private.require_company();
begin
  select * into v_quote from public.quotes where id = p_quote_id and company_id = v_company for update;
  if not found then
    raise exception 'Quote not found.';
  end if;
  if v_quote.status not in ('draft', 'sent') then
    raise exception 'Quote % is % and cannot be sent.', v_quote.quote_number, v_quote.status;
  end if;

  select * into v_version from public.quote_versions where id = v_quote.current_version_id for update;

  if v_version.locked_at is not null then
    return v_version;
  end if;

  if p_expected_edit_seq is not null and p_expected_edit_seq <> v_version.edit_seq then
    raise exception 'This quote was changed by someone else. Reload and review it before sending.'
      using errcode = 'PT409';
  end if;

  select count(*) into v_lines from public.quote_lines where quote_version_id = v_version.id;
  if v_lines = 0 then
    raise exception 'Add at least one line before sending the quote.';
  end if;

  update public.quote_versions v set
    locked_at = now(),
    locked_by = auth.uid(),
    bill_to_snapshot = (
      select jsonb_build_object(
        'customer_number', c.customer_number, 'name', c.name, 'email', c.email, 'phone', c.phone,
        'line1', c.billing_line1, 'line2', c.billing_line2, 'city', c.billing_city,
        'state', c.billing_state, 'postal_code', c.billing_postal_code,
        'payment_terms', c.payment_terms)
      from public.customers c where c.id = v_quote.customer_id),
    company_snapshot = (
      select jsonb_build_object(
        'company_name', s.company_name, 'line1', s.address_line1, 'line2', s.address_line2,
        'city', s.city, 'state', s.state, 'postal_code', s.postal_code, 'phone', s.phone,
        'email', s.email, 'website', s.website, 'footer_note', s.quote_footer_note,
        'timezone', s.timezone)
      from public.company_settings s where s.company_id = v_company)
  where v.id = v_version.id
  returning * into v_version;

  perform private.log_event('quote.issued', 'quote', v_quote.id,
    format('%s v%s issued', v_quote.quote_number, v_version.version_no),
    jsonb_build_object('version_id', v_version.id));

  return v_version;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.record_quote_delivery(p_quote_id uuid, p_version_id uuid, p_status delivery_status, p_to text[], p_cc text[], p_subject text, p_body text, p_provider text, p_provider_message_id text, p_error text, p_document jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_quote    public.quotes%rowtype;
  v_version  public.quote_versions%rowtype;
  v_doc_id   uuid;
  v_delivery uuid;
  v_company  uuid;
begin
  perform private.require_permission('quotes.send');
  v_company := private.require_company();

  select * into v_quote from public.quotes where id = p_quote_id and company_id = v_company for update;
  if not found then raise exception 'Quote not found.'; end if;
  select * into v_version from public.quote_versions where id = p_version_id and quote_id = p_quote_id for update;
  if not found then raise exception 'Quote version not found.'; end if;

  if p_status in ('sent', 'test_sent') and v_version.locked_at is null then
    raise exception 'Only issued versions can be recorded as sent.';
  end if;
  if p_to is null or cardinality(p_to) = 0 then
    raise exception 'At least one recipient is required.';
  end if;

  if p_document is not null then
    insert into public.documents (company_id, kind, quote_version_id, filename, sha256, byte_size, created_by)
    values (v_company, 'quote_pdf', v_version.id, p_document ->> 'filename', p_document ->> 'sha256',
            (p_document ->> 'byte_size')::integer, auth.uid())
    returning id into v_doc_id;
  end if;

  insert into public.email_deliveries (
    company_id, quote_id, quote_version_id, channel, status, to_addresses, cc_addresses, subject, body,
    provider, provider_message_id, error_message, document_id, created_by)
  values (
    v_company, p_quote_id, p_version_id, 'email', p_status, p_to, coalesce(p_cc, '{}'),
    left(coalesce(p_subject, ''), 300), left(coalesce(p_body, ''), 10000),
    coalesce(p_provider, ''), p_provider_message_id, left(p_error, 2000), v_doc_id, auth.uid())
  returning id into v_delivery;

  if p_status = 'sent' then
    if v_version.sent_at is null then
      update public.quote_versions set sent_at = now() where id = v_version.id;
    end if;
    update public.quotes set
      status = case when status = 'draft' then 'sent'::public.quote_status else status end,
      first_sent_at = coalesce(first_sent_at, now()),
      last_sent_at = now()
    where id = p_quote_id;
    if v_quote.status = 'draft' then
      perform private.record_status_change(p_quote_id, p_version_id, 'draft', 'sent',
        'Emailed to ' || array_to_string(p_to, ', '));
    end if;
    perform private.log_event('quote.emailed', 'quote', p_quote_id,
      format('%s v%s emailed to %s', v_quote.quote_number, v_version.version_no, array_to_string(p_to, ', ')),
      jsonb_build_object('delivery_id', v_delivery, 'version_id', p_version_id,
                         'provider_message_id', p_provider_message_id));
  elsif p_status in ('failed', 'test_sent') then
    -- Nothing reached the customer: release the lock so the draft stays editable.
    if v_version.sent_at is null and v_version.locked_at is not null then
      perform set_config('tlt.allow_version_unlock', 'on', true);
      update public.quote_versions set locked_at = null, locked_by = null,
        bill_to_snapshot = null, company_snapshot = null
      where id = v_version.id;
      perform set_config('tlt.allow_version_unlock', 'off', true);
    end if;
    perform private.log_event(
      case when p_status = 'failed' then 'quote.email_failed' else 'quote.email_test_sent' end,
      'quote', p_quote_id,
      case when p_status = 'failed'
        then format('Email of %s v%s failed', v_quote.quote_number, v_version.version_no)
        else format('%s v%s test email sent to %s (not delivered to customer)', v_quote.quote_number,
                    v_version.version_no, array_to_string(p_to, ', '))
      end,
      jsonb_build_object('delivery_id', v_delivery, 'error', left(p_error, 500)));
  else
    perform private.log_event('quote.email_' || p_status::text, 'quote', p_quote_id,
      format('%s v%s email %s (not delivered to customer)', v_quote.quote_number, v_version.version_no,
             replace(p_status::text, '_', ' ')),
      jsonb_build_object('delivery_id', v_delivery));
  end if;

  return jsonb_build_object('delivery_id', v_delivery, 'status', p_status);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.mark_quote_sent(p_quote_id uuid, p_expected_edit_seq integer, p_note text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_quote   public.quotes%rowtype;
  v_version public.quote_versions%rowtype;
  v_note    text := private.clean_text(p_note, 500, 'Note');
begin
  perform private.require_permission('quotes.send');
  if length(v_note) = 0 then
    raise exception 'Describe how the quote was delivered (for example "Printed and handed to customer").';
  end if;

  v_version := private.issue_current_version(p_quote_id, p_expected_edit_seq);
  select * into v_quote from public.quotes where id = p_quote_id;

  if v_version.sent_at is null then
    update public.quote_versions set sent_at = now() where id = v_version.id;
  end if;

  insert into public.email_deliveries (company_id, quote_id, quote_version_id, channel, status, to_addresses, note, provider, created_by)
  values (v_quote.company_id, p_quote_id, v_version.id, 'manual', 'sent', '{}', v_note, 'manual', auth.uid());

  update public.quotes set
    status = case when status = 'draft' then 'sent'::public.quote_status else status end,
    first_sent_at = coalesce(first_sent_at, now()),
    last_sent_at = now()
  where id = p_quote_id;

  if v_quote.status = 'draft' then
    perform private.record_status_change(p_quote_id, v_version.id, 'draft', 'sent', 'Marked sent: ' || v_note);
  end if;

  perform private.log_event('quote.marked_sent', 'quote', p_quote_id,
    format('%s v%s marked sent: %s', v_quote.quote_number, v_version.version_no, v_note),
    jsonb_build_object('version_id', v_version.id));

  return jsonb_build_object('version_id', v_version.id);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.revise_quote(p_quote_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_quote   public.quotes%rowtype;
  v_old     public.quote_versions%rowtype;
  v_new_id  uuid;
  v_reason  text := private.clean_text(p_reason, 500, 'Revision reason');
  v_next_no integer;
  v_company uuid;
begin
  perform private.require_permission('quotes.edit');
  v_company := private.require_company();

  select * into v_quote from public.quotes where id = p_quote_id and company_id = v_company for update;
  if not found then raise exception 'Quote not found.'; end if;

  if v_quote.status not in ('sent', 'declined', 'expired') then
    raise exception 'Quote % is %. Only sent, declined or expired quotes can be revised.',
      v_quote.quote_number, v_quote.status;
  end if;
  if length(v_reason) = 0 then
    raise exception 'Enter a reason for the revision.';
  end if;

  select * into v_old from public.quote_versions where id = v_quote.current_version_id;
  if v_old.locked_at is null then
    raise exception 'The current version is still a draft. Edit it instead of creating a revision.';
  end if;

  select max(version_no) + 1 into v_next_no from public.quote_versions where quote_id = p_quote_id;

  insert into public.quote_versions (
    company_id, quote_id, version_no, contact_id, contact_name, contact_email, contact_phone,
    site_id, site_label, site_line1, site_line2, site_city, site_state, site_postal_code,
    quote_date, valid_until, project_name, customer_po, job_instructions, terms, internal_notes,
    tax_rate_bp, subtotal_cents, discount_cents, taxable_cents, tax_cents, total_cents,
    revision_reason, created_by)
  select
    company_id, quote_id, v_next_no, contact_id, contact_name, contact_email, contact_phone,
    site_id, site_label, site_line1, site_line2, site_city, site_state, site_postal_code,
    private.business_today(v_company),
    greatest(valid_until, private.business_today(v_company) + (select quote_validity_days from public.company_settings where company_id = v_company)),
    project_name, customer_po, job_instructions, terms, internal_notes,
    tax_rate_bp, subtotal_cents, discount_cents, taxable_cents, tax_cents, total_cents,
    v_reason, auth.uid()
  from public.quote_versions where id = v_old.id
  returning id into v_new_id;

  insert into public.quote_lines (
    company_id, quote_version_id, line_no, kind, calc_method, material_id, charge_item_id, description,
    unit_code, unit_label, quantity, unit_rate_cents, percent_bp, catalog_rate_cents,
    catalog_percent_bp, price_source, taxable, amount_cents)
  select
    company_id, v_new_id, line_no, kind, calc_method, material_id, charge_item_id, description,
    unit_code, unit_label, quantity, unit_rate_cents, percent_bp, catalog_rate_cents,
    catalog_percent_bp, price_source, taxable, amount_cents
  from public.quote_lines where quote_version_id = v_old.id;

  update public.quotes set
    status = 'draft',
    current_version_id = v_new_id,
    closed_at = null,
    status_note = ''
  where id = p_quote_id;

  perform private.record_status_change(p_quote_id, v_new_id, v_quote.status, 'draft',
    format('Revision %s started: %s', v_next_no, v_reason));
  perform private.log_event('quote.revised', 'quote', p_quote_id,
    format('%s revision %s started: %s', v_quote.quote_number, v_next_no, v_reason),
    jsonb_build_object('from_version_id', v_old.id, 'to_version_id', v_new_id));

  return jsonb_build_object('version_id', v_new_id, 'version_no', v_next_no);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.set_quote_status(p_quote_id uuid, p_status quote_status, p_note text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_quote public.quotes%rowtype;
  v_note  text := private.clean_text(p_note, 500, 'Note');
begin
  perform private.require_permission('quotes.status');

  select * into v_quote from public.quotes where id = p_quote_id and company_id = private.require_company() for update;
  if not found then raise exception 'Quote not found.'; end if;

  if v_quote.status = p_status then
    return jsonb_build_object('status', p_status, 'changed', false);
  end if;

  if not private.quote_transition_allowed(v_quote.status, p_status) then
    raise exception 'A % quote cannot be marked %.', v_quote.status, p_status;
  end if;

  if p_status in ('declined', 'canceled') and length(v_note) = 0 then
    raise exception 'Enter a reason.';
  end if;

  update public.quotes set
    status = p_status,
    status_note = v_note,
    accepted_version_id = case when p_status = 'accepted' then current_version_id else accepted_version_id end,
    accepted_at = case when p_status = 'accepted' then now() else accepted_at end,
    closed_at = case when p_status in ('declined', 'expired', 'canceled') then now() else null end
  where id = p_quote_id;

  perform private.record_status_change(p_quote_id, v_quote.current_version_id, v_quote.status, p_status, v_note);
  perform private.log_event('quote.status_changed', 'quote', p_quote_id,
    format('%s marked %s%s', v_quote.quote_number, p_status,
           case when length(v_note) > 0 then ': ' || v_note else '' end),
    jsonb_build_object('from', v_quote.status, 'to', p_status));

  return jsonb_build_object('status', p_status, 'changed', true);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.convert_quote_to_order(p_quote_id uuid)
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
    bill_to_snapshot, contact_name, contact_email, contact_phone,
    site_id, site_label, site_line1, site_line2, site_city, site_state, site_postal_code,
    project_name, customer_po, job_instructions, terms, internal_notes,
    tax_rate_bp, subtotal_cents, discount_cents, taxable_cents, tax_cents, total_cents,
    is_sample, created_by)
  values (
    v_company, private.next_document_number(v_company, 'order'), v_quote.customer_id, 'confirmed', v_quote.id, v_version.id,
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

CREATE OR REPLACE FUNCTION public.remove_sample_data()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_quotes integer;
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
    format('Sample data removed: %s quotes, %s customers, %s materials, %s charges, %s price lists',
           v_quotes, v_customers, v_materials, v_charges, v_lists),
    jsonb_build_object('quotes', v_quotes, 'customers', v_customers, 'materials', v_materials,
                       'charge_items', v_charges, 'price_lists', v_lists,
                       'deactivated_in_use', jsonb_build_object(
                         'customers', v_customers_kept, 'materials', v_materials_kept,
                         'charge_items', v_charges_kept)));

  return jsonb_build_object('quotes', v_quotes, 'customers', v_customers, 'materials', v_materials,
                            'charge_items', v_charges, 'price_lists', v_lists,
                            'deactivated_in_use', v_customers_kept + v_materials_kept + v_charges_kept);
end;
$function$
;

-- =============================================================================
-- 15. Column defaults: rows inserted by app users belong to their company.
--     Tables written only by functions get no default (explicit company id).
-- =============================================================================
do $$
declare
  t text;
begin
  foreach t in array array[
    'units_of_measure', 'price_lists', 'customers', 'customer_contacts', 'customer_sites',
    'materials', 'charge_items', 'price_list_entries'] loop
    execute format('alter table public.%I alter column company_id set default private.current_company_id()', t);
  end loop;
  foreach t in array array[
    'company_settings', 'document_sequences', 'role_permissions', 'audit_events', 'quotes',
    'quote_versions', 'quote_lines', 'quote_status_events', 'documents', 'email_deliveries',
    'orders', 'order_lines', 'order_status_events'] loop
    execute format('alter table public.%I alter column company_id drop default', t);
  end loop;
end
$$;

-- =============================================================================
-- 16. Roles now live on memberships
-- =============================================================================
do $$
begin
  if (select count(*) from public.company_memberships) <> (select count(*) from public.profiles)
     or exists (
       select 1 from public.profiles p
       left join public.company_memberships m
         on m.user_id = p.id and m.company_id = '00000000-0000-4000-8000-000000000001'
       where m.user_id is null or m.role is distinct from p.role or m.active is distinct from p.active) then
    raise exception 'Membership backfill does not match profiles; aborting.';
  end if;
end
$$;

alter table public.profiles drop column role;
alter table public.profiles drop column active;

-- =============================================================================
-- 17. Row Level Security — rewritten for company isolation.
--     Pattern: company_id = (select private.current_company_id())
--              and (select private.has_permission('…'))
--     The (select …) form lets Postgres evaluate each helper once per query.
-- =============================================================================
do $$
declare
  r record;
begin
  for r in select schemaname, tablename, policyname from pg_policies where schemaname = 'public' loop
    execute format('drop policy %I on %I.%I', r.policyname, r.schemaname, r.tablename);
  end loop;
end
$$;

alter table public.companies enable row level security;
alter table public.company_memberships enable row level security;
alter table public.role_permission_defaults enable row level security;

-- Companies: members see their own companies.
create policy companies_read on public.companies for select to authenticated
  using (id in (select m.company_id from public.company_memberships m where m.user_id = (select auth.uid())));

-- Memberships: your own, or everyone in your company if you manage users.
create policy company_memberships_read on public.company_memberships for select to authenticated
  using (user_id = (select auth.uid())
         or (company_id = (select private.current_company_id()) and (select private.has_permission('users.manage'))));

-- Profiles: yourself, or members of your company if you manage users.
create policy profiles_read on public.profiles for select to authenticated
  using (id = (select auth.uid())
         or ((select private.has_permission('users.manage')) and private.is_company_member(id)));

-- Global catalogs.
create policy permissions_read on public.permissions for select to authenticated using (true);
create policy role_permission_defaults_read on public.role_permission_defaults for select to authenticated using (true);

-- Company administration.
create policy role_permissions_read on public.role_permissions for select to authenticated
  using (company_id = (select private.current_company_id()));
create policy audit_read on public.audit_events for select to authenticated
  using (company_id = (select private.current_company_id()) and (select private.has_permission('audit.view')));
create policy company_settings_read on public.company_settings for select to authenticated
  using (company_id = (select private.current_company_id()));
create policy company_settings_update on public.company_settings for update to authenticated
  using (company_id = (select private.current_company_id()) and (select private.has_permission('settings.manage')))
  with check (company_id = (select private.current_company_id()) and (select private.has_permission('settings.manage')));
create policy document_sequences_read on public.document_sequences for select to authenticated
  using (company_id = (select private.current_company_id()));
create policy document_sequences_update on public.document_sequences for update to authenticated
  using (company_id = (select private.current_company_id()) and (select private.has_permission('settings.manage')))
  with check (company_id = (select private.current_company_id()) and (select private.has_permission('settings.manage')));

-- Generic business-table policies.
create or replace function pg_temp.tenant_policies(p_table text, p_read text[], p_write text, p_delete boolean)
returns void
language plpgsql
as $$
declare
  v_company constant text := 'company_id = (select private.current_company_id())';
  v_read text;
  v_write text;
begin
  select string_agg(format('(select private.has_permission(%L))', p), ' or ') into v_read from unnest(p_read) p;
  execute format('create policy %I on public.%I for select to authenticated using (%s and (%s))',
                 p_table || '_read', p_table, v_company, v_read);
  if p_write is not null then
    v_write := format('%s and (select private.has_permission(%L))', v_company, p_write);
    execute format('create policy %I on public.%I for insert to authenticated with check (%s)', p_table || '_insert', p_table, v_write);
    execute format('create policy %I on public.%I for update to authenticated using (%s) with check (%s)', p_table || '_update', p_table, v_write, v_write);
    if p_delete then
      execute format('create policy %I on public.%I for delete to authenticated using (%s)', p_table || '_delete', p_table, v_write);
    end if;
  end if;
end;
$$;

-- Units are readable by every member of the company.
create policy units_read on public.units_of_measure for select to authenticated
  using (company_id = (select private.current_company_id()));
create policy units_insert on public.units_of_measure for insert to authenticated
  with check (company_id = (select private.current_company_id()) and (select private.has_permission('materials.edit')));
create policy units_update on public.units_of_measure for update to authenticated
  using (company_id = (select private.current_company_id()) and (select private.has_permission('materials.edit')))
  with check (company_id = (select private.current_company_id()) and (select private.has_permission('materials.edit')));

select pg_temp.tenant_policies('customers', array['customers.view', 'quotes.view'], 'customers.edit', false);
select pg_temp.tenant_policies('customer_contacts', array['customers.view', 'quotes.view'], 'customers.edit', false);
select pg_temp.tenant_policies('customer_sites', array['customers.view', 'quotes.view'], 'customers.edit', false);
select pg_temp.tenant_policies('materials', array['materials.view', 'quotes.view'], 'materials.edit', false);
select pg_temp.tenant_policies('charge_items', array['materials.view', 'quotes.view'], 'materials.edit', false);
select pg_temp.tenant_policies('price_lists', array['materials.view', 'quotes.view'], 'pricing.edit', false);
select pg_temp.tenant_policies('price_list_entries', array['materials.view', 'quotes.view'], 'pricing.edit', true);
select pg_temp.tenant_policies('quotes', array['quotes.view'], null, false);
select pg_temp.tenant_policies('quote_versions', array['quotes.view'], null, false);
select pg_temp.tenant_policies('quote_lines', array['quotes.view'], null, false);
select pg_temp.tenant_policies('quote_status_events', array['quotes.view'], null, false);
select pg_temp.tenant_policies('documents', array['quotes.view'], null, false);
select pg_temp.tenant_policies('email_deliveries', array['quotes.view'], null, false);
select pg_temp.tenant_policies('orders', array['orders.view'], null, false);
select pg_temp.tenant_policies('order_lines', array['orders.view'], null, false);
select pg_temp.tenant_policies('order_status_events', array['orders.view'], null, false);

-- =============================================================================
-- 18. Grants
-- =============================================================================
revoke all on public.companies, public.company_memberships, public.role_permission_defaults from anon, authenticated;
grant select on public.companies, public.company_memberships, public.role_permission_defaults to authenticated;
grant select on public.companies, public.company_memberships, public.role_permission_defaults to service_role;
grant insert, update, delete on public.companies, public.company_memberships to service_role;

-- company_id can never change on update (a_company_guard trigger) and inserts
-- may only target the caller's company (RLS WITH CHECK).

revoke execute on all functions in schema public from public, anon;
revoke execute on all functions in schema private from public, anon, authenticated;

grant execute on function
  public.my_access(),
  public.set_user_access(uuid, public.app_role, boolean, text),
  public.add_company_member(uuid, public.app_role, text),
  public.set_role_permission(public.app_role, text, boolean),
  public.user_directory(),
  public.effective_prices(uuid, date),
  public.save_quote_draft(jsonb),
  public.issue_quote_version(uuid, integer),
  public.record_quote_delivery(uuid, uuid, public.delivery_status, text[], text[], text, text, text, text, text, jsonb),
  public.mark_quote_sent(uuid, integer, text),
  public.revise_quote(uuid, text),
  public.set_quote_status(uuid, public.quote_status, text),
  public.convert_quote_to_order(uuid),
  public.sample_data_counts(),
  public.remove_sample_data()
to authenticated;

-- Helpers used inside RLS policies and column defaults (evaluated as the caller).
grant execute on function
  private.current_company_id(),
  private.has_permission(text),
  private.is_company_member(uuid)
to authenticated;

-- private.create_company, private.next_document_number and the other internal
-- helpers stay unavailable to app users.

-- =============================================================================
-- 19. Verification — abort if anything does not add up
-- =============================================================================
do $$
declare
  r record;
  v_now bigint;
  v_tl constant uuid := '00000000-0000-4000-8000-000000000001';
  v_other bigint;
begin
  -- Row counts unchanged.
  for r in select * from tenancy_precheck where t <> 'profiles' loop
    execute format('select count(*) from public.%I', r.t) into v_now;
    if v_now <> r.n then
      raise exception 'Row count changed for %: before %, after %', r.t, r.n, v_now;
    end if;
    execute format('select count(*) from public.%I where company_id is distinct from %L', r.t, v_tl) into v_other;
    if v_other <> 0 then
      raise exception '% rows in % are not owned by Top Line', v_other, r.t;
    end if;
  end loop;

  -- Money unchanged.
  if exists (
    select 1 from tenancy_quote_totals b join public.quote_versions v using (id)
    where (b.total_cents, b.subtotal_cents, b.tax_cents, b.discount_cents)
          is distinct from (v.total_cents, v.subtotal_cents, v.tax_cents, v.discount_cents)) then
    raise exception 'Quote totals changed during migration';
  end if;

  -- Every business table has RLS and a non-null company_id (except audit).
  for r in
    select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity loop
    raise exception 'RLS disabled on %', r.relname;
  end loop;
  for r in
    select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
      and c.relname not in ('companies', 'profiles', 'permissions', 'role_permission_defaults')
      and not exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'company_id') loop
    raise exception 'Table % has no company_id', r.relname;
  end loop;
end
$$;

drop table tenancy_precheck;
drop table tenancy_quote_totals;
