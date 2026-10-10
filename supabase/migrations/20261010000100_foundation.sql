-- =============================================================================
-- Top Line Trucking Manager — Foundation
-- Roles & permissions, user profiles, company settings, document numbering,
-- audit log, shared helper functions.
-- =============================================================================

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Enums
-- -----------------------------------------------------------------------------
create type public.app_role as enum ('owner', 'office', 'dispatcher', 'driver');

-- -----------------------------------------------------------------------------
-- Generic helpers
-- -----------------------------------------------------------------------------
create or replace function private.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- Permissions catalog and role mapping (single source of truth for RLS,
-- RPC functions, and the UI)
-- -----------------------------------------------------------------------------
create table public.permissions (
  code        text primary key check (code ~ '^[a-z_]+\.[a-z_]+$'),
  category    text not null,
  description text not null
);

create table public.role_permissions (
  role       public.app_role not null,
  permission text not null references public.permissions (code) on delete cascade,
  primary key (role, permission)
);

insert into public.permissions (code, category, description) values
  ('customers.view',      'Customers', 'View customers, contacts and job sites'),
  ('customers.edit',      'Customers', 'Create, edit and archive customers'),
  ('materials.view',      'Materials & Pricing', 'View materials, charges and price lists'),
  ('materials.edit',      'Materials & Pricing', 'Create and edit materials and charge items'),
  ('pricing.edit',        'Materials & Pricing', 'Edit price lists and rates'),
  ('pricing.override',    'Materials & Pricing', 'Override configured prices and apply discounts on quotes'),
  ('quotes.view',         'Quotes', 'View quotes and quote history'),
  ('quotes.edit',         'Quotes', 'Create, edit and revise quotes'),
  ('quotes.send',         'Quotes', 'Email quotes or mark them as sent'),
  ('quotes.status',       'Quotes', 'Mark quotes accepted, declined, expired or canceled'),
  ('settings.manage',     'Administration', 'Edit company settings and document numbering'),
  ('users.manage',        'Administration', 'Invite users and change roles and permissions'),
  ('audit.view',          'Administration', 'View the audit log');

insert into public.role_permissions (role, permission)
select 'owner'::public.app_role, code from public.permissions;

insert into public.role_permissions (role, permission) values
  ('office', 'customers.view'), ('office', 'customers.edit'),
  ('office', 'materials.view'), ('office', 'materials.edit'), ('office', 'pricing.edit'),
  ('office', 'quotes.view'), ('office', 'quotes.edit'), ('office', 'quotes.send'), ('office', 'quotes.status'),
  ('dispatcher', 'customers.view'), ('dispatcher', 'materials.view'), ('dispatcher', 'quotes.view');

-- -----------------------------------------------------------------------------
-- Profiles (one per auth user). role = null means "pending": the account can
-- sign in but cannot see any business data until an owner assigns a role.
-- -----------------------------------------------------------------------------
create table public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  email      text not null,
  full_name  text not null default '',
  role       public.app_role,
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger profiles_touch before update on public.profiles
  for each row execute function private.touch_updated_at();

create or replace function private.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (
    new.id,
    coalesce(new.email, ''),
    coalesce(new.raw_user_meta_data ->> 'full_name', '')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_auth_user();

-- -----------------------------------------------------------------------------
-- Permission helpers
-- -----------------------------------------------------------------------------
create or replace function private.current_app_role()
returns public.app_role
language sql
stable
security definer
set search_path = ''
as $$
  select p.role
  from public.profiles p
  where p.id = auth.uid() and p.active
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
    from public.profiles p
    join public.role_permissions rp on rp.role = p.role
    where p.id = auth.uid()
      and p.active
      and rp.permission = p_permission
  )
$$;

create or replace function private.require_permission(p_permission text)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.has_permission(p_permission) then
    raise exception 'You do not have permission to perform this action (%).', p_permission
      using errcode = '42501';
  end if;
end;
$$;

grant execute on function private.has_permission(text) to authenticated;
grant execute on function private.require_permission(text) to authenticated;
grant execute on function private.current_app_role() to authenticated;

-- Used by the application server to load the signed-in user's access.
create or replace function public.my_access()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'user_id', p.id,
    'email', p.email,
    'full_name', p.full_name,
    'role', p.role,
    'active', p.active,
    'permissions', coalesce(
      (select jsonb_agg(rp.permission order by rp.permission)
       from public.role_permissions rp
       where rp.role = p.role and p.active),
      '[]'::jsonb)
  )
  from public.profiles p
  where p.id = auth.uid()
$$;

-- -----------------------------------------------------------------------------
-- Audit log (append-only)
-- -----------------------------------------------------------------------------
create table public.audit_events (
  id           uuid primary key default gen_random_uuid(),
  occurred_at  timestamptz not null default now(),
  actor_id     uuid references auth.users (id) on delete set null,
  action       text not null,
  entity_type  text not null,
  entity_id    uuid,
  summary      text not null default '',
  details      jsonb not null default '{}'::jsonb
);

create index audit_events_entity_idx on public.audit_events (entity_type, entity_id, occurred_at desc);
create index audit_events_occurred_idx on public.audit_events (occurred_at desc);

create or replace function private.prevent_modification()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception '% rows are append-only and cannot be changed or deleted.', tg_table_name
    using errcode = '42501';
end;
$$;

create trigger audit_events_append_only
  before update or delete on public.audit_events
  for each row execute function private.prevent_modification();

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
  insert into public.audit_events (actor_id, action, entity_type, entity_id, summary, details)
  values (auth.uid(), p_action, p_entity_type, p_entity_id, coalesce(p_summary, ''), coalesce(p_details, '{}'::jsonb));
$$;

-- Generic row-change audit trigger. TG_ARGV[0] = entity type label.
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

  insert into public.audit_events (actor_id, action, entity_type, entity_id, summary, details)
  values (
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

create trigger role_permissions_audit
  after insert or update or delete on public.role_permissions
  for each row execute function private.audit_row_change('role_permission');

-- role_permissions has no id column; the audit row still records the change details.

create trigger profiles_audit
  after update on public.profiles
  for each row execute function private.audit_row_change('user');

-- -----------------------------------------------------------------------------
-- Company settings (singleton)
-- -----------------------------------------------------------------------------
create table public.company_settings (
  id                    boolean primary key default true check (id),
  company_name          text not null default 'Top Line Trucking',
  address_line1         text not null default '',
  address_line2         text not null default '',
  city                  text not null default '',
  state                 text not null default 'IN',
  postal_code           text not null default '',
  phone                 text not null default '',
  email                 text not null default '',
  website               text not null default '',
  timezone              text not null default 'America/Chicago',
  default_tax_rate_bp   integer not null default 0 check (default_tax_rate_bp between 0 and 2500),
  quote_validity_days   integer not null default 30 check (quote_validity_days between 1 and 365),
  quote_followup_days   integer not null default 3 check (quote_followup_days between 1 and 90),
  default_quote_terms   text not null default '',
  quote_footer_note     text not null default '',
  updated_at            timestamptz not null default now(),
  updated_by            uuid references auth.users (id) on delete set null
);

insert into public.company_settings (id, default_quote_terms, quote_footer_note) values (
  true,
  'Pricing is based on the quantities and delivery location shown. Actual charges are based on delivered quantities. '
  || 'Delivery times are estimates and depend on weather, site access and material availability. '
  || 'Customer is responsible for providing safe, accessible dump/delivery locations. '
  || 'This quote is valid until the expiration date shown.',
  'Thank you for the opportunity to quote this work.'
);

create trigger company_settings_touch before update on public.company_settings
  for each row execute function private.touch_updated_at();

create trigger company_settings_audit
  after update on public.company_settings
  for each row execute function private.audit_row_change('company_settings');

create or replace function private.business_timezone()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select timezone from public.company_settings where id), 'America/Chicago')
$$;

create or replace function private.business_today()
returns date
language sql
stable
security definer
set search_path = ''
as $$
  select (now() at time zone private.business_timezone())::date
$$;

-- -----------------------------------------------------------------------------
-- Sequential, human-readable document numbers. Row lock makes concurrent
-- allocation safe; a rolled-back transaction releases its number.
-- -----------------------------------------------------------------------------
create table public.document_sequences (
  key           text primary key check (key in ('customer', 'quote', 'order', 'ticket')),
  label         text not null,
  prefix        text not null default '' check (length(prefix) <= 10 and prefix ~ '^[A-Za-z0-9-]*$'),
  include_year  boolean not null default false,
  pad           integer not null default 4 check (pad between 1 and 10),
  next_value    bigint not null default 1 check (next_value >= 1),
  current_year  integer,
  updated_at    timestamptz not null default now()
);

insert into public.document_sequences (key, label, prefix, include_year, pad) values
  ('customer', 'Customer numbers', 'C-', false, 5),
  ('quote',    'Quote numbers',    'Q-', true,  4),
  ('order',    'Order numbers',    'O-', true,  4),
  ('ticket',   'Ticket numbers',   'T-', true,  5);

create trigger document_sequences_touch before update on public.document_sequences
  for each row execute function private.touch_updated_at();

create trigger document_sequences_audit
  after update on public.document_sequences
  for each row execute function private.audit_row_change('document_sequence');

create or replace function private.next_document_number(p_key text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_seq   public.document_sequences%rowtype;
  v_year  integer := extract(year from (now() at time zone private.business_timezone()))::integer;
  v_value bigint;
begin
  select * into v_seq from public.document_sequences where key = p_key for update;
  if not found then
    raise exception 'Unknown document sequence %', p_key;
  end if;

  if v_seq.include_year and v_seq.current_year is distinct from v_year then
    v_value := 1;
  else
    v_value := v_seq.next_value;
  end if;

  update public.document_sequences
     set next_value = v_value + 1,
         current_year = v_year
   where key = p_key;

  return v_seq.prefix
      || case when v_seq.include_year then v_year::text || '-' else '' end
      || lpad(v_value::text, v_seq.pad, '0');
end;
$$;

-- -----------------------------------------------------------------------------
-- User administration RPCs
-- -----------------------------------------------------------------------------
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
  v_remaining_owners integer;
begin
  perform private.require_permission('users.manage');

  if p_full_name is null or length(trim(p_full_name)) = 0 or length(p_full_name) > 120 then
    raise exception 'Name is required (120 characters max).';
  end if;

  update public.profiles
     set role = p_role,
         active = p_active,
         full_name = trim(p_full_name)
   where id = p_user_id;

  if not found then
    raise exception 'User not found.';
  end if;

  select count(*) into v_remaining_owners
  from public.profiles where role = 'owner' and active;

  if v_remaining_owners = 0 then
    raise exception 'At least one active owner account is required.';
  end if;
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
begin
  perform private.require_permission('users.manage');

  if p_role = 'owner' then
    raise exception 'Owner permissions cannot be changed.';
  end if;

  if p_granted then
    insert into public.role_permissions (role, permission)
    values (p_role, p_permission)
    on conflict do nothing;
  else
    delete from public.role_permissions
     where role = p_role and permission = p_permission;
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- Row Level Security
-- -----------------------------------------------------------------------------
alter table public.permissions enable row level security;
alter table public.role_permissions enable row level security;
alter table public.profiles enable row level security;
alter table public.audit_events enable row level security;
alter table public.company_settings enable row level security;
alter table public.document_sequences enable row level security;

create policy permissions_read on public.permissions
  for select to authenticated using (true);

create policy role_permissions_read on public.role_permissions
  for select to authenticated using (true);

create policy profiles_read_self on public.profiles
  for select to authenticated
  using (id = auth.uid() or private.has_permission('users.manage'));

create policy audit_read on public.audit_events
  for select to authenticated
  using (private.has_permission('audit.view'));

create policy company_settings_read on public.company_settings
  for select to authenticated
  using (private.current_app_role() is not null);

create policy company_settings_update on public.company_settings
  for update to authenticated
  using (private.has_permission('settings.manage'))
  with check (private.has_permission('settings.manage'));

create policy document_sequences_read on public.document_sequences
  for select to authenticated
  using (private.current_app_role() is not null);

create policy document_sequences_update on public.document_sequences
  for update to authenticated
  using (private.has_permission('settings.manage'))
  with check (private.has_permission('settings.manage'));

-- -----------------------------------------------------------------------------
-- Grants (explicit; anon gets nothing)
-- -----------------------------------------------------------------------------
revoke all on public.permissions, public.role_permissions, public.profiles,
  public.audit_events, public.company_settings, public.document_sequences
  from anon, authenticated;

grant select on public.permissions, public.role_permissions, public.profiles,
  public.audit_events, public.company_settings, public.document_sequences
  to authenticated;
grant update (company_name, address_line1, address_line2, city, state, postal_code, phone,
  email, website, timezone, default_tax_rate_bp, quote_validity_days, quote_followup_days,
  default_quote_terms, quote_footer_note, updated_by)
  on public.company_settings to authenticated;
grant update (prefix, include_year, pad, next_value) on public.document_sequences to authenticated;

revoke execute on function public.my_access() from public, anon;
revoke execute on function public.set_user_access(uuid, public.app_role, boolean, text) from public, anon;
revoke execute on function public.set_role_permission(public.app_role, text, boolean) from public, anon;
grant execute on function public.my_access() to authenticated;
grant execute on function public.set_user_access(uuid, public.app_role, boolean, text) to authenticated;
grant execute on function public.set_role_permission(public.app_role, text, boolean) to authenticated;
