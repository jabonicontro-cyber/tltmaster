-- =============================================================================
-- Quotes: header, versions (immutable once issued), line items with pricing
-- snapshots, status history, email deliveries, generated documents.
-- All writes go through SECURITY DEFINER functions that validate input,
-- enforce permissions and compute totals (the database is authoritative).
-- =============================================================================

create type public.quote_status as enum ('draft', 'sent', 'accepted', 'declined', 'expired', 'canceled');
create type public.price_source as enum ('customer', 'standard', 'manual', 'override');
create type public.delivery_status as enum ('sent', 'failed', 'preview', 'test_sent');
create type public.delivery_channel as enum ('email', 'manual');

create table public.quotes (
  id                   uuid primary key default gen_random_uuid(),
  quote_number         text not null unique,
  customer_id          uuid not null references public.customers (id),
  status               public.quote_status not null default 'draft',
  current_version_id   uuid,
  accepted_version_id  uuid,
  first_sent_at        timestamptz,
  last_sent_at         timestamptz,
  accepted_at          timestamptz,
  closed_at            timestamptz,
  status_note          text not null default '',
  is_sample            boolean not null default false,
  created_by           uuid references auth.users (id) on delete set null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create index quotes_customer_idx on public.quotes (customer_id);
create index quotes_status_idx on public.quotes (status);
create index quotes_created_idx on public.quotes (created_at desc);

create table public.quote_versions (
  id                    uuid primary key default gen_random_uuid(),
  quote_id              uuid not null references public.quotes (id) on delete cascade,
  version_no            integer not null check (version_no >= 1),
  edit_seq              integer not null default 1,
  -- who / where
  contact_id            uuid references public.customer_contacts (id) on delete set null,
  contact_name          text not null default '',
  contact_email         text not null default '',
  contact_phone         text not null default '',
  site_id               uuid references public.customer_sites (id) on delete set null,
  site_label            text not null default '',
  site_line1            text not null default '',
  site_line2            text not null default '',
  site_city             text not null default '',
  site_state            text not null default '',
  site_postal_code      text not null default '',
  -- commercial details
  quote_date            date not null,
  valid_until           date not null,
  project_name          text not null default '',
  customer_po           text not null default '',
  job_instructions      text not null default '',
  terms                 text not null default '',
  internal_notes        text not null default '',
  tax_rate_bp           integer not null default 0 check (tax_rate_bp between 0 and 2500),
  -- totals (computed by public.save_quote_draft)
  subtotal_cents        bigint not null default 0,
  discount_cents        bigint not null default 0,
  taxable_cents         bigint not null default 0,
  tax_cents             bigint not null default 0,
  total_cents           bigint not null default 0,
  -- revision / issue
  revision_reason       text not null default '',
  locked_at             timestamptz,
  locked_by             uuid references auth.users (id) on delete set null,
  sent_at               timestamptz,
  bill_to_snapshot      jsonb,
  company_snapshot      jsonb,
  created_by            uuid references auth.users (id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (quote_id, version_no),
  constraint quote_versions_dates check (valid_until >= quote_date),
  constraint quote_versions_sent_locked check (sent_at is null or locked_at is not null)
);

alter table public.quotes
  add constraint quotes_current_version_fk foreign key (current_version_id)
    references public.quote_versions (id) deferrable initially deferred,
  add constraint quotes_accepted_version_fk foreign key (accepted_version_id)
    references public.quote_versions (id) deferrable initially deferred;

create table public.quote_lines (
  id                   uuid primary key default gen_random_uuid(),
  quote_version_id     uuid not null references public.quote_versions (id) on delete cascade,
  line_no              integer not null check (line_no >= 1),
  kind                 public.charge_kind not null,
  calc_method          public.calc_method not null,
  material_id          uuid references public.materials (id),
  charge_item_id       uuid references public.charge_items (id),
  description          text not null check (length(trim(description)) between 1 and 300),
  unit_code            text references public.units_of_measure (code),
  unit_label           text not null default '',
  quantity             numeric(12, 3),
  unit_rate_cents      bigint,
  percent_bp           integer,
  catalog_rate_cents   bigint,
  catalog_percent_bp   integer,
  price_source         public.price_source not null,
  taxable              boolean not null default false,
  amount_cents         bigint not null,
  unique (quote_version_id, line_no),
  constraint quote_lines_item check (num_nonnulls(material_id, charge_item_id) <= 1),
  constraint quote_lines_material_kind check (material_id is null or kind = 'material'),
  constraint quote_lines_per_unit check (
    calc_method <> 'per_unit' or (
      quantity is not null and quantity > 0 and quantity <= 999999.999
      and unit_rate_cents is not null and unit_rate_cents between 0 and 100000000
      and unit_code is not null and percent_bp is null)
  ),
  constraint quote_lines_percent check (
    calc_method <> 'percent_of_subtotal' or (
      percent_bp is not null and percent_bp between 1 and 10000
      and quantity is null and unit_rate_cents is null and kind <> 'material')
  )
);

create index quote_lines_version_idx on public.quote_lines (quote_version_id);

create table public.quote_status_events (
  id            uuid primary key default gen_random_uuid(),
  quote_id      uuid not null references public.quotes (id) on delete cascade,
  version_id    uuid references public.quote_versions (id) on delete set null,
  from_status   public.quote_status,
  to_status     public.quote_status not null,
  note          text not null default '',
  actor_id      uuid references auth.users (id) on delete set null,
  occurred_at   timestamptz not null default now()
);

create index quote_status_events_quote_idx on public.quote_status_events (quote_id, occurred_at desc);

create table public.documents (
  id                uuid primary key default gen_random_uuid(),
  kind              text not null check (kind in ('quote_pdf')),
  quote_version_id  uuid references public.quote_versions (id) on delete cascade,
  filename          text not null,
  sha256            text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  byte_size         integer not null check (byte_size > 0),
  created_by        uuid references auth.users (id) on delete set null,
  created_at        timestamptz not null default now()
);

create index documents_version_idx on public.documents (quote_version_id);

create table public.email_deliveries (
  id                   uuid primary key default gen_random_uuid(),
  quote_id             uuid not null references public.quotes (id) on delete cascade,
  quote_version_id     uuid not null references public.quote_versions (id) on delete cascade,
  channel              public.delivery_channel not null,
  status               public.delivery_status not null,
  to_addresses         text[] not null default '{}',
  cc_addresses         text[] not null default '{}',
  subject              text not null default '',
  body                 text not null default '',
  provider             text not null default '',
  provider_message_id  text,
  error_message        text,
  document_id          uuid references public.documents (id) on delete set null,
  note                 text not null default '',
  created_by           uuid references auth.users (id) on delete set null,
  created_at           timestamptz not null default now()
);

create index email_deliveries_quote_idx on public.email_deliveries (quote_id, created_at desc);

create trigger quotes_touch before update on public.quotes
  for each row execute function private.touch_updated_at();
create trigger quote_versions_touch before update on public.quote_versions
  for each row execute function private.touch_updated_at();

create trigger quote_status_events_append_only before update or delete on public.quote_status_events
  for each row execute function private.prevent_modification();
create trigger email_deliveries_append_only before update or delete on public.email_deliveries
  for each row execute function private.prevent_modification();
create trigger documents_append_only before update or delete on public.documents
  for each row execute function private.prevent_modification();

-- -----------------------------------------------------------------------------
-- Immutability of issued versions
-- -----------------------------------------------------------------------------
create or replace function private.guard_locked_version()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_old jsonb;
  v_new jsonb;
  v_allowed constant text[] := array['sent_at', 'updated_at'];
begin
  if tg_op = 'DELETE' then
    if old.locked_at is not null then
      raise exception 'Quote % version % has been issued and cannot be deleted.', old.quote_id, old.version_no
        using errcode = '42501';
    end if;
    return old;
  end if;

  if old.locked_at is null then
    return new;
  end if;

  -- Releasing a lock is only possible from public.record_quote_delivery when
  -- an issued version was never delivered.
  if new.locked_at is null and current_setting('tlt.allow_version_unlock', true) = 'on' and old.sent_at is null then
    return new;
  end if;

  v_old := to_jsonb(old) - v_allowed;
  v_new := to_jsonb(new) - v_allowed;
  if v_old <> v_new then
    raise exception 'This quote version has been issued and cannot be changed. Create a revision instead.'
      using errcode = '42501';
  end if;
  if old.sent_at is not null and new.sent_at is distinct from old.sent_at then
    raise exception 'The sent time of an issued version cannot be changed.' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger quote_versions_guard before update or delete on public.quote_versions
  for each row execute function private.guard_locked_version();

create or replace function private.guard_locked_lines()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_version_id uuid := coalesce(new.quote_version_id, old.quote_version_id);
begin
  if exists (select 1 from public.quote_versions v where v.id = v_version_id and v.locked_at is not null) then
    raise exception 'Lines of an issued quote version cannot be changed. Create a revision instead.'
      using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and new.quote_version_id <> old.quote_version_id then
    raise exception 'Quote lines cannot be moved between versions.' using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger quote_lines_guard before insert or update or delete on public.quote_lines
  for each row execute function private.guard_locked_lines();

-- -----------------------------------------------------------------------------
-- Status rules (mirrored in src/lib/quotes/status.ts and tested)
-- -----------------------------------------------------------------------------
create or replace function private.quote_transition_allowed(p_from public.quote_status, p_to public.quote_status)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select (p_from, p_to) in (
    ('draft'::public.quote_status,    'canceled'::public.quote_status),
    ('sent',     'accepted'),
    ('sent',     'declined'),
    ('sent',     'expired'),
    ('sent',     'canceled'),
    ('declined', 'canceled'),
    ('expired',  'canceled'),
    ('accepted', 'canceled')
  )
$$;

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
  insert into public.quote_status_events (quote_id, version_id, from_status, to_status, note, actor_id)
  values (p_quote_id, p_version_id, p_from, p_to, coalesce(p_note, ''), auth.uid());
$$;

-- -----------------------------------------------------------------------------
-- Money helpers. numeric round() rounds half away from zero, matching
-- src/lib/money.ts.
-- -----------------------------------------------------------------------------
create or replace function private.line_amount_cents(
  p_kind public.charge_kind,
  p_method public.calc_method,
  p_quantity numeric,
  p_rate_cents bigint,
  p_percent_bp integer,
  p_base_cents bigint
)
returns bigint
language sql
immutable
set search_path = ''
as $$
  select (case when p_kind = 'discount' then -1 else 1 end) *
         case p_method
           when 'per_unit' then round(p_quantity * p_rate_cents)::bigint
           else round(p_base_cents::numeric * p_percent_bp / 10000)::bigint
         end
$$;

-- -----------------------------------------------------------------------------
-- Text helpers
-- -----------------------------------------------------------------------------
create or replace function private.clean_text(p_value text, p_max integer, p_field text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v text := coalesce(trim(p_value), '');
begin
  if length(v) > p_max then
    raise exception '% is too long (maximum % characters).', p_field, p_max;
  end if;
  return v;
end;
$$;

-- -----------------------------------------------------------------------------
-- Save (create or update) the current draft version of a quote.
--
-- p_payload:
-- {
--   "quote_id": uuid | null,          -- null creates a new quote
--   "customer_id": uuid,
--   "expected_edit_seq": int | null,  -- optimistic concurrency for updates
--   "contact_id": uuid | null, "contact_name", "contact_email", "contact_phone",
--   "site_id": uuid | null, "site_label", "site_line1", "site_line2", "site_city",
--   "site_state", "site_postal_code", "save_site": bool,
--   "quote_date": date, "valid_until": date, "project_name", "customer_po",
--   "job_instructions", "terms", "internal_notes", "tax_rate_bp": int,
--   "lines": [{ "kind", "calc_method", "material_id", "charge_item_id",
--               "description", "unit_code", "quantity", "unit_rate_cents",
--               "percent_bp", "taxable" }]
-- }
-- Returns { quote_id, quote_number, version_id, version_no, edit_seq, total_cents }
-- -----------------------------------------------------------------------------
create or replace function public.save_quote_draft(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
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
begin
  perform private.require_permission('quotes.edit');

  if jsonb_typeof(v_lines) <> 'array' then
    raise exception 'Lines must be a list.';
  end if;
  if jsonb_array_length(v_lines) > 200 then
    raise exception 'A quote can have at most 200 lines.';
  end if;

  select * into v_customer from public.customers where id = (p_payload ->> 'customer_id')::uuid;
  if not found then
    raise exception 'Select a customer for this quote.';
  end if;

  -- Locate / create quote and draft version --------------------------------
  if v_is_new then
    if not v_customer.active then
      raise exception 'Customer % is archived. Reactivate the customer before quoting.', v_customer.name;
    end if;

    insert into public.quotes (quote_number, customer_id, status, is_sample, created_by)
    values (private.next_document_number('quote'), v_customer.id, 'draft', v_customer.is_sample, auth.uid())
    returning * into v_quote;

    insert into public.quote_versions (quote_id, version_no, quote_date, valid_until, created_by)
    values (v_quote.id, 1, private.business_today(),
            private.business_today() + (select quote_validity_days from public.company_settings where id),
            auth.uid())
    returning * into v_version;

    update public.quotes set current_version_id = v_version.id where id = v_quote.id;

    perform private.record_status_change(v_quote.id, v_version.id, null, 'draft', 'Quote created');
  else
    select * into v_quote from public.quotes where id = (p_payload ->> 'quote_id')::uuid for update;
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
    insert into public.customer_sites (customer_id, label, line1, line2, city, state, postal_code)
    values (
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
      select true into v_item_ok from public.materials where id = v_material_id;
      if v_item_ok is null then raise exception 'Line %: material not found.', v_line_no; end if;
      if v_kind <> 'material' then raise exception 'Line %: material lines must be of type material.', v_line_no; end if;
    end if;
    if v_charge_id is not null then
      select true into v_item_ok from public.charge_items where id = v_charge_id;
      if v_item_ok is null then raise exception 'Line %: charge not found.', v_line_no; end if;
    end if;
    v_item_ok := null;

    if length(v_desc) = 0 then
      raise exception 'Line %: a description is required.', v_line_no;
    end if;

    if v_method = 'per_unit' then
      v_unit_code := nullif(v_line ->> 'unit_code', '');
      select label into v_unit_label from public.units_of_measure where code = v_unit_code;
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
      quote_version_id, line_no, kind, calc_method, material_id, charge_item_id, description,
      unit_code, unit_label, quantity, unit_rate_cents, percent_bp, catalog_rate_cents,
      catalog_percent_bp, price_source, taxable, amount_cents)
    values (
      v_version.id, v_line_no, v_kind, v_method, v_material_id, v_charge_id, v_desc,
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
$$;

create or replace function private.recompute_quote_totals(p_version_id uuid)
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
  select tax_rate_bp into v_tax_bp from public.quote_versions where id = p_version_id;

  select
    coalesce(sum(amount_cents) filter (where kind <> 'discount'), 0),
    coalesce(-sum(amount_cents) filter (where kind = 'discount'), 0),
    greatest(coalesce(sum(amount_cents) filter (where taxable), 0), 0)
  into v_subtotal, v_discount, v_taxable
  from public.quote_lines
  where quote_version_id = p_version_id;

  v_tax := round(v_taxable::numeric * v_tax_bp / 10000)::bigint;

  update public.quote_versions set
    subtotal_cents = v_subtotal,
    discount_cents = v_discount,
    taxable_cents  = v_taxable,
    tax_cents      = v_tax,
    total_cents    = v_subtotal - v_discount + v_tax
  where id = p_version_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- Issue (lock) the current version. Captures bill-to and company snapshots so
-- the issued document never changes. Idempotent for an already-locked version.
-- -----------------------------------------------------------------------------
create or replace function private.issue_current_version(p_quote_id uuid, p_expected_edit_seq integer)
returns public.quote_versions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_quote   public.quotes%rowtype;
  v_version public.quote_versions%rowtype;
  v_lines   integer;
begin
  select * into v_quote from public.quotes where id = p_quote_id for update;
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
      from public.company_settings s where s.id)
  where v.id = v_version.id
  returning * into v_version;

  perform private.log_event('quote.issued', 'quote', v_quote.id,
    format('%s v%s issued', v_quote.quote_number, v_version.version_no),
    jsonb_build_object('version_id', v_version.id));

  return v_version;
end;
$$;

-- Called by the server before rendering + emailing. Returns the locked version.
create or replace function public.issue_quote_version(p_quote_id uuid, p_expected_edit_seq integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_version public.quote_versions%rowtype;
begin
  perform private.require_permission('quotes.send');
  v_version := private.issue_current_version(p_quote_id, p_expected_edit_seq);
  return jsonb_build_object('version_id', v_version.id, 'version_no', v_version.version_no);
end;
$$;

-- -----------------------------------------------------------------------------
-- Record the outcome of a delivery attempt.
--   status 'sent'      → quote becomes Sent, version.sent_at set
--   status 'test_sent' → test mode; quote status unchanged
--   status 'preview'   → nothing was sent; quote status unchanged
--   status 'failed'    → nothing was sent; if the version was never delivered
--                        it is unlocked again so it can still be edited
-- p_document: { filename, sha256, byte_size } of the attached PDF (optional)
-- -----------------------------------------------------------------------------
create or replace function public.record_quote_delivery(
  p_quote_id uuid,
  p_version_id uuid,
  p_status public.delivery_status,
  p_to text[],
  p_cc text[],
  p_subject text,
  p_body text,
  p_provider text,
  p_provider_message_id text,
  p_error text,
  p_document jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_quote    public.quotes%rowtype;
  v_version  public.quote_versions%rowtype;
  v_doc_id   uuid;
  v_delivery uuid;
begin
  perform private.require_permission('quotes.send');

  select * into v_quote from public.quotes where id = p_quote_id for update;
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
    insert into public.documents (kind, quote_version_id, filename, sha256, byte_size, created_by)
    values ('quote_pdf', v_version.id, p_document ->> 'filename', p_document ->> 'sha256',
            (p_document ->> 'byte_size')::integer, auth.uid())
    returning id into v_doc_id;
  end if;

  insert into public.email_deliveries (
    quote_id, quote_version_id, channel, status, to_addresses, cc_addresses, subject, body,
    provider, provider_message_id, error_message, document_id, created_by)
  values (
    p_quote_id, p_version_id, 'email', p_status, p_to, coalesce(p_cc, '{}'),
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
  elsif p_status = 'failed' then
    if v_version.sent_at is null and v_version.locked_at is not null then
      perform set_config('tlt.allow_version_unlock', 'on', true);
      update public.quote_versions set locked_at = null, locked_by = null,
        bill_to_snapshot = null, company_snapshot = null
      where id = v_version.id;
      perform set_config('tlt.allow_version_unlock', 'off', true);
    end if;
    perform private.log_event('quote.email_failed', 'quote', p_quote_id,
      format('Email of %s v%s failed', v_quote.quote_number, v_version.version_no),
      jsonb_build_object('delivery_id', v_delivery, 'error', left(p_error, 500)));
  else
    perform private.log_event('quote.email_' || p_status::text, 'quote', p_quote_id,
      format('%s v%s email %s (not delivered to customer)', v_quote.quote_number, v_version.version_no,
             replace(p_status::text, '_', ' ')),
      jsonb_build_object('delivery_id', v_delivery));
  end if;

  return jsonb_build_object('delivery_id', v_delivery, 'status', p_status);
end;
$$;

-- Mark sent without emailing from the system (printed, handed over, emailed
-- from another program). Issues the version in the same transaction.
create or replace function public.mark_quote_sent(p_quote_id uuid, p_expected_edit_seq integer, p_note text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
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

  insert into public.email_deliveries (quote_id, quote_version_id, channel, status, to_addresses, note, provider, created_by)
  values (p_quote_id, v_version.id, 'manual', 'sent', '{}', v_note, 'manual', auth.uid());

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
$$;

-- -----------------------------------------------------------------------------
-- Revise: copy the current issued version into a new draft version.
-- -----------------------------------------------------------------------------
create or replace function public.revise_quote(p_quote_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_quote   public.quotes%rowtype;
  v_old     public.quote_versions%rowtype;
  v_new_id  uuid;
  v_reason  text := private.clean_text(p_reason, 500, 'Revision reason');
  v_next_no integer;
begin
  perform private.require_permission('quotes.edit');

  select * into v_quote from public.quotes where id = p_quote_id for update;
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
    quote_id, version_no, contact_id, contact_name, contact_email, contact_phone,
    site_id, site_label, site_line1, site_line2, site_city, site_state, site_postal_code,
    quote_date, valid_until, project_name, customer_po, job_instructions, terms, internal_notes,
    tax_rate_bp, subtotal_cents, discount_cents, taxable_cents, tax_cents, total_cents,
    revision_reason, created_by)
  select
    quote_id, v_next_no, contact_id, contact_name, contact_email, contact_phone,
    site_id, site_label, site_line1, site_line2, site_city, site_state, site_postal_code,
    private.business_today(),
    greatest(valid_until, private.business_today() + (select quote_validity_days from public.company_settings where id)),
    project_name, customer_po, job_instructions, terms, internal_notes,
    tax_rate_bp, subtotal_cents, discount_cents, taxable_cents, tax_cents, total_cents,
    v_reason, auth.uid()
  from public.quote_versions where id = v_old.id
  returning id into v_new_id;

  insert into public.quote_lines (
    quote_version_id, line_no, kind, calc_method, material_id, charge_item_id, description,
    unit_code, unit_label, quantity, unit_rate_cents, percent_bp, catalog_rate_cents,
    catalog_percent_bp, price_source, taxable, amount_cents)
  select
    v_new_id, line_no, kind, calc_method, material_id, charge_item_id, description,
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
$$;

-- -----------------------------------------------------------------------------
-- Status changes: accepted / declined / expired / canceled
-- -----------------------------------------------------------------------------
create or replace function public.set_quote_status(p_quote_id uuid, p_status public.quote_status, p_note text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_quote public.quotes%rowtype;
  v_note  text := private.clean_text(p_note, 500, 'Note');
begin
  perform private.require_permission('quotes.status');

  select * into v_quote from public.quotes where id = p_quote_id for update;
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
$$;

-- -----------------------------------------------------------------------------
-- List view (security_invoker so RLS of the underlying tables applies)
-- -----------------------------------------------------------------------------
create view public.quote_list
with (security_invoker = true)
as
select
  q.id,
  q.quote_number,
  q.status,
  q.customer_id,
  c.name as customer_name,
  c.customer_number,
  q.is_sample,
  q.created_at,
  q.updated_at,
  q.first_sent_at,
  q.last_sent_at,
  q.accepted_at,
  v.id as version_id,
  v.version_no,
  v.quote_date,
  v.valid_until,
  v.project_name,
  v.site_label,
  v.site_line1,
  v.site_city,
  v.total_cents,
  v.locked_at
from public.quotes q
join public.customers c on c.id = q.customer_id
join public.quote_versions v on v.id = q.current_version_id;

-- -----------------------------------------------------------------------------
-- RLS: read-only for clients; all writes through the functions above.
-- -----------------------------------------------------------------------------
alter table public.quotes enable row level security;
alter table public.quote_versions enable row level security;
alter table public.quote_lines enable row level security;
alter table public.quote_status_events enable row level security;
alter table public.documents enable row level security;
alter table public.email_deliveries enable row level security;

create policy quotes_read on public.quotes for select to authenticated
  using (private.has_permission('quotes.view'));
create policy quote_versions_read on public.quote_versions for select to authenticated
  using (private.has_permission('quotes.view'));
create policy quote_lines_read on public.quote_lines for select to authenticated
  using (private.has_permission('quotes.view'));
create policy quote_status_events_read on public.quote_status_events for select to authenticated
  using (private.has_permission('quotes.view'));
create policy documents_read on public.documents for select to authenticated
  using (private.has_permission('quotes.view'));
create policy email_deliveries_read on public.email_deliveries for select to authenticated
  using (private.has_permission('quotes.view'));

revoke all on public.quotes, public.quote_versions, public.quote_lines,
  public.quote_status_events, public.documents, public.email_deliveries, public.quote_list
  from anon, authenticated;
grant select on public.quotes, public.quote_versions, public.quote_lines,
  public.quote_status_events, public.documents, public.email_deliveries, public.quote_list
  to authenticated;

revoke execute on function public.save_quote_draft(jsonb) from public, anon;
revoke execute on function public.issue_quote_version(uuid, integer) from public, anon;
revoke execute on function public.record_quote_delivery(uuid, uuid, public.delivery_status, text[], text[], text, text, text, text, text, jsonb) from public, anon;
revoke execute on function public.mark_quote_sent(uuid, integer, text) from public, anon;
revoke execute on function public.revise_quote(uuid, text) from public, anon;
revoke execute on function public.set_quote_status(uuid, public.quote_status, text) from public, anon;

grant execute on function public.save_quote_draft(jsonb) to authenticated;
grant execute on function public.issue_quote_version(uuid, integer) to authenticated;
grant execute on function public.record_quote_delivery(uuid, uuid, public.delivery_status, text[], text[], text, text, text, text, text, jsonb) to authenticated;
grant execute on function public.mark_quote_sent(uuid, integer, text) to authenticated;
grant execute on function public.revise_quote(uuid, text) to authenticated;
grant execute on function public.set_quote_status(uuid, public.quote_status, text) to authenticated;

-- Private helpers are reachable only from the functions above; make sure
-- nothing in the private schema is executable by anon.
revoke execute on all functions in schema private from public, anon;
grant execute on function private.has_permission(text) to authenticated;
grant execute on function private.current_app_role() to authenticated;
