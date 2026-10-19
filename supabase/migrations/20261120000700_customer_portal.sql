-- =============================================================================
-- Customer portal (B66): a trucking company's own customers sign in to see their orders, deliveries and quotes,
-- request quotes, ask for support and read the company's help articles.
--
-- Security model
--   * A portal account belongs to exactly one company and one customer. It is NOT a company membership: it grants no
--     role, no permission and no RLS access to any business table. private.current_company_id() stays null for a
--     customer, so every existing policy keeps refusing them.
--   * Customers read and write only through the portal_* functions below (security definer, search_path ''). Each
--     derives the company and customer from auth.uid() and the active account row; the slug argument only chooses
--     among the caller's own accounts. Record ids from the client are always re-checked against that customer.
--   * Only fields a customer may see are returned: never internal notes, scheduling notes, review notes, driver,
--     truck or employee details, pricing rules or other customers' records.
--   * The portal is off for every company until (1) the platform owner marks the company entitled and (2) the company
--     enables it in Settings. Demo companies are entitled by their sample data, not by a code branch.
--   * Invitations are one-time tokens (sha256 stored, 7-day expiry). Public tracking links are revocable, expiring
--     tokens that show only an order's status, schedule and delivered quantities.
--   * A customer's quote acceptance is recorded as a response; the company confirms it with the existing quote status
--     workflow (which may create the order). A customer never changes a quote's status directly.
-- Rollback: supabase/rollbacks/20261120000700_customer_portal.down.sql
-- =============================================================================

-- Entitlement (platform owner) -------------------------------------------------------------------------------------
create table private.portal_entitlements (
  company_id uuid primary key references public.companies (id) on delete cascade,
  entitled   boolean not null default false,
  note       text not null default '' check (length(note) <= 500),
  set_by     uuid references auth.users (id) on delete set null,
  set_at     timestamptz not null default now()
);
revoke all on private.portal_entitlements from public, anon, authenticated;

create or replace function private.portal_entitled(p_company uuid)
 returns boolean
 language sql
 stable
 security definer
 set search_path to ''
as $$
  select coalesce((select e.entitled from private.portal_entitlements e where e.company_id = p_company), false);
$$;
revoke all on function private.portal_entitled(uuid) from public, anon, authenticated;

-- Settings (company) -----------------------------------------------------------------------------------------------
create table public.portal_settings (
  company_id        uuid primary key references public.companies (id) on delete cascade,
  enabled           boolean not null default false,
  public_page       boolean not null default false,
  display_name      text not null default '' check (length(display_name) <= 120),
  welcome           text not null default '' check (length(welcome) <= 2000),
  contact_email     text not null default '' check (length(contact_email) <= 200),
  contact_phone     text not null default '' check (length(contact_phone) <= 40),
  hours             text not null default '' check (length(hours) <= 500),
  feature_orders    boolean not null default true,
  feature_quotes    boolean not null default true,
  feature_documents boolean not null default true,
  feature_support   boolean not null default true,
  feature_help      boolean not null default true,
  feature_tracking  boolean not null default false,
  updated_at        timestamptz not null default now(),
  updated_by        uuid references auth.users (id) on delete set null
);
alter table public.portal_settings enable row level security;
create policy portal_settings_read on public.portal_settings for select to authenticated
  using (company_id = (select private.current_company_id()));
grant select on public.portal_settings to authenticated;

-- Accounts ---------------------------------------------------------------------------------------------------------
create table public.portal_accounts (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references public.companies (id),
  customer_id       uuid not null,
  contact_id        uuid,
  email             text not null check (length(email) <= 254 and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  user_id           uuid references auth.users (id) on delete set null,
  status            text not null default 'invited' check (status in ('invited', 'active', 'revoked')),
  invite_hash       text,
  invite_expires_at timestamptz,
  invited_by        uuid references auth.users (id) on delete set null,
  invited_at        timestamptz not null default now(),
  accepted_at       timestamptz,
  revoked_at        timestamptz,
  revoked_by        uuid references auth.users (id) on delete set null,
  last_seen_at      timestamptz,
  unique (company_id, id),
  foreign key (company_id, customer_id) references public.customers (company_id, id) on delete cascade,
  foreign key (company_id, contact_id) references public.customer_contacts (company_id, id) on delete set null (contact_id)
);
create unique index portal_accounts_email on public.portal_accounts (company_id, lower(email)) where status <> 'revoked';
create unique index portal_accounts_invite on public.portal_accounts (invite_hash) where invite_hash is not null;
create index portal_accounts_user on public.portal_accounts (user_id) where status = 'active';
create index portal_accounts_customer on public.portal_accounts (company_id, customer_id);
alter table public.portal_accounts enable row level security;
create policy portal_accounts_read on public.portal_accounts for select to authenticated
  using (company_id = (select private.current_company_id()) and (select private.has_permission('customers.view')));
grant select (id, company_id, customer_id, contact_id, email, status, invite_expires_at, invited_by, invited_at, accepted_at,
              revoked_at, last_seen_at) on public.portal_accounts to authenticated;

-- Quote requests, quote responses, support ---------------------------------------------------------------------------
create table public.portal_quote_requests (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.companies (id),
  customer_id    uuid not null,
  account_id     uuid not null,
  site_id        uuid,
  site_text      text not null default '' check (length(site_text) <= 300),
  material       text not null check (length(btrim(material)) between 1 and 200),
  quantity       numeric check (quantity is null or (quantity > 0 and quantity < 1000000)),
  unit           text not null default '' check (length(unit) <= 30),
  requested_date date,
  notes          text not null default '' check (length(notes) <= 2000),
  status         text not null default 'new' check (status in ('new', 'reviewing', 'quoted', 'declined', 'withdrawn')),
  quote_id       uuid,
  staff_note     text not null default '' check (length(staff_note) <= 1000),
  created_by     uuid references auth.users (id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (company_id, id),
  foreign key (company_id, customer_id) references public.customers (company_id, id) on delete cascade,
  foreign key (company_id, account_id) references public.portal_accounts (company_id, id),
  foreign key (company_id, site_id) references public.customer_sites (company_id, id) on delete set null (site_id),
  foreign key (company_id, quote_id) references public.quotes (company_id, id) on delete set null (quote_id)
);
create index portal_quote_requests_company on public.portal_quote_requests (company_id, created_at desc);
alter table public.portal_quote_requests enable row level security;
create policy portal_quote_requests_read on public.portal_quote_requests for select to authenticated
  using (company_id = (select private.current_company_id()) and (select private.has_permission('quotes.view')));
grant select on public.portal_quote_requests to authenticated;

create table public.portal_quote_responses (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies (id),
  quote_id     uuid not null,
  version_id   uuid,
  account_id   uuid not null,
  response     text not null check (response in ('accept', 'decline')),
  signer_name  text not null check (length(btrim(signer_name)) between 1 and 120),
  note         text not null default '' check (length(note) <= 1000),
  status       text not null default 'pending' check (status in ('pending', 'confirmed', 'dismissed')),
  handled_by   uuid references auth.users (id) on delete set null,
  handled_at   timestamptz,
  created_by   uuid references auth.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  foreign key (company_id, quote_id) references public.quotes (company_id, id) on delete cascade,
  foreign key (company_id, version_id) references public.quote_versions (company_id, id) on delete set null (version_id),
  foreign key (company_id, account_id) references public.portal_accounts (company_id, id)
);
create unique index portal_quote_responses_open on public.portal_quote_responses (quote_id) where status = 'pending';
alter table public.portal_quote_responses enable row level security;
create policy portal_quote_responses_read on public.portal_quote_responses for select to authenticated
  using (company_id = (select private.current_company_id()) and (select private.has_permission('quotes.view')));
grant select on public.portal_quote_responses to authenticated;

create table public.portal_support_requests (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies (id),
  customer_id uuid not null,
  account_id  uuid not null,
  order_id    uuid,
  subject     text not null check (length(btrim(subject)) between 1 and 160),
  status      text not null default 'open' check (status in ('open', 'answered', 'closed')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (company_id, id),
  foreign key (company_id, customer_id) references public.customers (company_id, id) on delete cascade,
  foreign key (company_id, account_id) references public.portal_accounts (company_id, id),
  foreign key (company_id, order_id) references public.orders (company_id, id) on delete set null (order_id)
);
create index portal_support_requests_company on public.portal_support_requests (company_id, updated_at desc);
alter table public.portal_support_requests enable row level security;
create policy portal_support_requests_read on public.portal_support_requests for select to authenticated
  using (company_id = (select private.current_company_id()) and (select private.has_permission('customers.view')));
grant select on public.portal_support_requests to authenticated;

create table public.portal_messages (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies (id),
  request_id  uuid not null,
  author_kind text not null check (author_kind in ('customer', 'staff')),
  author_id   uuid references auth.users (id) on delete set null,
  body        text not null check (length(btrim(body)) between 1 and 4000),
  created_at  timestamptz not null default now(),
  foreign key (company_id, request_id) references public.portal_support_requests (company_id, id) on delete cascade
);
create index portal_messages_request on public.portal_messages (request_id, created_at);
create trigger portal_messages_append_only before update or delete on public.portal_messages
  for each row execute function private.prevent_modification();
alter table public.portal_messages enable row level security;
create policy portal_messages_read on public.portal_messages for select to authenticated
  using (company_id = (select private.current_company_id()) and (select private.has_permission('customers.view')));
grant select on public.portal_messages to authenticated;

-- Help articles written by the company for its customers --------------------------------------------------------------
create table public.portal_help_articles (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies (id),
  title        text not null check (length(btrim(title)) between 1 and 160),
  category     text not null default 'General' check (length(btrim(category)) between 1 and 60),
  body         text not null default '' check (length(body) <= 20000),
  status       text not null default 'draft' check (status in ('draft', 'published', 'retired')),
  created_by   uuid references auth.users (id) on delete set null,
  updated_by   uuid references auth.users (id) on delete set null,
  published_by uuid references auth.users (id) on delete set null,
  published_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (company_id, id)
);
alter table public.portal_help_articles enable row level security;
create policy portal_help_articles_read on public.portal_help_articles for select to authenticated
  using (company_id = (select private.current_company_id()));
grant select on public.portal_help_articles to authenticated;

create table public.portal_help_feedback (
  company_id uuid not null references public.companies (id),
  article_id uuid not null,
  account_id uuid not null,
  helpful    boolean not null,
  created_at timestamptz not null default now(),
  primary key (article_id, account_id),
  foreign key (company_id, article_id) references public.portal_help_articles (company_id, id) on delete cascade,
  foreign key (company_id, account_id) references public.portal_accounts (company_id, id) on delete cascade
);
alter table public.portal_help_feedback enable row level security;
create policy portal_help_feedback_read on public.portal_help_feedback for select to authenticated
  using (company_id = (select private.current_company_id()) and (select private.has_permission('settings.manage')));
grant select on public.portal_help_feedback to authenticated;

-- Tracking links ---------------------------------------------------------------------------------------------------
create table public.portal_tracking_links (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id),
  order_id   uuid not null,
  token_hash text not null unique,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (company_id, order_id) references public.orders (company_id, id) on delete cascade
);
alter table public.portal_tracking_links enable row level security;
create policy portal_tracking_links_read on public.portal_tracking_links for select to authenticated
  using (company_id = (select private.current_company_id()) and (select private.has_permission('orders.view')));
grant select (id, company_id, order_id, expires_at, revoked_at, created_by, created_at) on public.portal_tracking_links to authenticated;

-- Rate limiting for customer submissions ---------------------------------------------------------------------------
create table private.portal_attempts (
  account_id uuid not null,
  kind       text not null,
  at         timestamptz not null default now()
);
create index portal_attempts_lookup on private.portal_attempts (account_id, kind, at desc);
revoke all on private.portal_attempts from public, anon, authenticated;

-- Helpers ----------------------------------------------------------------------------------------------------------
create or replace function private.portal_hash(p_token text)
 returns text
 language sql
 immutable
 set search_path to ''
as $$
  select encode(sha256(convert_to(coalesce(p_token, ''), 'UTF8')), 'hex');
$$;
revoke all on function private.portal_hash(text) from public, anon, authenticated;

create or replace function private.portal_token()
 returns text
 language sql
 volatile
 set search_path to ''
as $$
  select replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
$$;
revoke all on function private.portal_token() from public, anon, authenticated;

-- Is the portal open for this company right now (entitled, enabled, active, not archived)?
create or replace function private.portal_open(p_company uuid)
 returns boolean
 language sql
 stable
 security definer
 set search_path to ''
as $$
  select exists (
    select 1 from public.companies c join public.portal_settings s on s.company_id = c.id
    where c.id = p_company and c.active and c.archived_at is null and s.enabled and private.portal_entitled(c.id));
$$;
revoke all on function private.portal_open(uuid) from public, anon, authenticated;

-- The caller's active account in the company named by the slug. Raises the same error for every refusal so nothing is
-- revealed about which companies, customers or accounts exist.
create or replace function private.portal_me(p_slug text)
 returns public.portal_accounts
 language plpgsql
 stable
 security definer
 set search_path to ''
as $$
declare
  v public.portal_accounts%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Not available.' using errcode = '42501';
  end if;
  select a.* into v
  from public.portal_accounts a join public.companies c on c.id = a.company_id
  where c.slug = p_slug and a.user_id = auth.uid() and a.status = 'active'
    and exists (select 1 from public.customers cu where cu.company_id = a.company_id and cu.id = a.customer_id and cu.active);
  if not found or not private.portal_open(v.company_id) then
    raise exception 'Not available.' using errcode = '42501';
  end if;
  return v;
end;
$$;
revoke all on function private.portal_me(text) from public, anon, authenticated;

create or replace function private.portal_feature(p_company uuid, p_feature text)
 returns boolean
 language sql
 stable
 security definer
 set search_path to ''
as $$
  select coalesce((select case p_feature
      when 'orders' then s.feature_orders when 'quotes' then s.feature_quotes when 'documents' then s.feature_documents
      when 'support' then s.feature_support when 'help' then s.feature_help when 'tracking' then s.feature_tracking
      else false end
    from public.portal_settings s where s.company_id = p_company), false);
$$;
revoke all on function private.portal_feature(uuid, text) from public, anon, authenticated;

create or replace function private.portal_require_feature(p_company uuid, p_feature text)
 returns void
 language plpgsql
 stable
 security definer
 set search_path to ''
as $$
begin
  if not private.portal_feature(p_company, p_feature) then
    raise exception 'This is not available in the portal.' using errcode = '42501';
  end if;
end;
$$;
revoke all on function private.portal_require_feature(uuid, text) from public, anon, authenticated;

create or replace function private.portal_log(p_company uuid, p_action text, p_entity_type text, p_entity_id uuid, p_summary text, p_details jsonb default '{}'::jsonb)
 returns void
 language sql
 security definer
 set search_path to ''
as $$
  insert into public.audit_events (company_id, actor_id, action, entity_type, entity_id, summary, details)
  values (p_company, auth.uid(), p_action, p_entity_type, p_entity_id, coalesce(p_summary, ''), coalesce(p_details, '{}'::jsonb));
$$;
revoke all on function private.portal_log(uuid, text, text, uuid, text, jsonb) from public, anon, authenticated;

create or replace function private.portal_rate(p_account uuid, p_kind text, p_per_day integer)
 returns void
 language plpgsql
 security definer
 set search_path to ''
as $$
begin
  if (select count(*) from private.portal_attempts a where a.account_id = p_account and a.kind = p_kind and a.at > now() - interval '1 day') >= p_per_day then
    raise exception 'Too many requests today. Please call or email us instead.' using errcode = '54000';
  end if;
  insert into private.portal_attempts (account_id, kind) values (p_account, p_kind);
end;
$$;
revoke all on function private.portal_rate(uuid, text, integer) from public, anon, authenticated;

-- Branding and public info shared by the public page and the signed-in context.
create or replace function private.portal_company_card(p_company uuid)
 returns jsonb
 language sql
 stable
 security definer
 set search_path to ''
as $$
  select jsonb_build_object(
    'name', coalesce(nullif(s.display_name, ''), nullif(cs.company_name, ''), c.name),
    'slug', c.slug,
    'logo', coalesce(cs.brand_logo, ''),
    'color', coalesce(cs.brand_color, ''),
    'welcome', s.welcome,
    'contact_email', coalesce(nullif(s.contact_email, ''), cs.email, ''),
    'contact_phone', coalesce(nullif(s.contact_phone, ''), cs.phone, ''),
    'hours', s.hours,
    'is_demo', c.is_demo,
    'features', jsonb_build_object('orders', s.feature_orders, 'quotes', s.feature_quotes, 'documents', s.feature_documents,
                                   'support', s.feature_support, 'help', s.feature_help, 'tracking', s.feature_tracking))
  from public.companies c
  join public.portal_settings s on s.company_id = c.id
  left join public.company_settings cs on cs.company_id = c.id
  where c.id = p_company;
$$;
revoke all on function private.portal_company_card(uuid) from public, anon, authenticated;

-- Customer-facing labels (no internal state names leak to customers).
create or replace function private.portal_order_label(p_status public.order_status)
 returns text
 language sql
 immutable
 set search_path to ''
as $$
  select case p_status
    when 'confirmed' then 'Confirmed' when 'scheduled' then 'Scheduled' when 'dispatched' then 'Scheduled'
    when 'in_progress' then 'Delivering' when 'partially_completed' then 'Partly delivered'
    when 'completed' then 'Delivered' when 'on_hold' then 'On hold' when 'canceled' then 'Canceled'
    else 'Received' end;
$$;
revoke all on function private.portal_order_label(public.order_status) from public, anon, authenticated;

-- Delivered quantities: confirmed = accepted tickets; reported = submitted or under review (not yet confirmed).
create or replace function private.portal_order_summary(p_order uuid)
 returns jsonb
 language sql
 stable
 security definer
 set search_path to ''
as $$
  select jsonb_build_object(
    'id', o.id, 'number', o.order_number, 'status', o.status, 'status_label', private.portal_order_label(o.status),
    'requested_date', o.requested_date, 'scheduled_start', o.scheduled_start, 'scheduled_end', o.scheduled_end,
    'window_start', o.window_start, 'window_end', o.window_end,
    'site', concat_ws(', ', nullif(o.site_label, ''), nullif(o.site_city, '')), 'project', o.project_name, 'po', o.customer_po,
    'materials', (select string_agg(distinct l.description, ', ') from public.order_lines l where l.order_id = o.id and l.kind = 'material'),
    'loads_planned', (select count(*) from public.order_loads ld where ld.order_id = o.id and ld.status = 'planned'),
    'tickets_confirmed', (select count(*) from public.delivery_tickets t where t.order_id = o.id and t.status = 'accepted'),
    'tickets_reported', (select count(*) from public.delivery_tickets t where t.order_id = o.id and t.status in ('submitted', 'needs_review')),
    'quantity_confirmed', (select coalesce(sum(t.quantity), 0) from public.delivery_tickets t where t.order_id = o.id and t.status = 'accepted'),
    'next_load', (select jsonb_build_object('date', ld.load_date, 'start', ld.start_time, 'end', ld.end_time)
                  from public.order_loads ld where ld.order_id = o.id and ld.status = 'planned' and ld.load_date >= current_date
                  order by ld.load_date, ld.start_time nulls last limit 1),
    'updated_at', o.updated_at)
  from public.orders o where o.id = p_order;
$$;
revoke all on function private.portal_order_summary(uuid) from public, anon, authenticated;

-- Staff: settings, entitlement, invitations ----------------------------------------------------------------------------
create or replace function public.portal_admin_state()
 returns jsonb
 language plpgsql
 stable
 security definer
 set search_path to ''
as $$
declare
  v_company uuid := private.require_company();
begin
  perform private.require_permission('customers.view');
  return jsonb_build_object(
    'entitled', private.portal_entitled(v_company),
    'open', private.portal_open(v_company),
    'slug', (select slug from public.companies where id = v_company),
    'settings', (select to_jsonb(s) - 'company_id' - 'updated_by' from public.portal_settings s where s.company_id = v_company));
end;
$$;

create or replace function public.portal_save_settings(p jsonb)
 returns void
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  v_company uuid := private.require_company();
  v_email text := private.clean_text(p ->> 'contact_email', 200, 'Contact email');
begin
  perform private.require_permission('settings.manage');
  if coalesce((p ->> 'enabled')::boolean, false) and not private.portal_entitled(v_company) then
    raise exception 'The customer portal is not included in your plan yet. Ask Taviron to turn it on.' using errcode = '42501';
  end if;
  if v_email <> '' and v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'Enter a valid contact email.' using errcode = '22023';
  end if;
  insert into public.portal_settings as s (company_id, enabled, public_page, display_name, welcome, contact_email, contact_phone, hours,
    feature_orders, feature_quotes, feature_documents, feature_support, feature_help, feature_tracking, updated_at, updated_by)
  values (v_company, coalesce((p ->> 'enabled')::boolean, false), coalesce((p ->> 'public_page')::boolean, false),
    private.clean_text(p ->> 'display_name', 120, 'Display name'), private.clean_text(p ->> 'welcome', 2000, 'Welcome message'),
    v_email, private.clean_text(p ->> 'contact_phone', 40, 'Contact phone'), private.clean_text(p ->> 'hours', 500, 'Hours'),
    coalesce((p ->> 'feature_orders')::boolean, true), coalesce((p ->> 'feature_quotes')::boolean, true),
    coalesce((p ->> 'feature_documents')::boolean, true), coalesce((p ->> 'feature_support')::boolean, true),
    coalesce((p ->> 'feature_help')::boolean, true), coalesce((p ->> 'feature_tracking')::boolean, false), now(), auth.uid())
  on conflict (company_id) do update set
    enabled = excluded.enabled, public_page = excluded.public_page, display_name = excluded.display_name, welcome = excluded.welcome,
    contact_email = excluded.contact_email, contact_phone = excluded.contact_phone, hours = excluded.hours,
    feature_orders = excluded.feature_orders, feature_quotes = excluded.feature_quotes, feature_documents = excluded.feature_documents,
    feature_support = excluded.feature_support, feature_help = excluded.feature_help, feature_tracking = excluded.feature_tracking,
    updated_at = now(), updated_by = auth.uid();
  perform private.log_event('portal.settings_saved', 'portal_settings', v_company, 'Customer portal settings saved',
    jsonb_build_object('enabled', coalesce((p ->> 'enabled')::boolean, false), 'public_page', coalesce((p ->> 'public_page')::boolean, false)));
end;
$$;

create or replace function public.platform_portal_set_entitlement(p_company uuid, p_entitled boolean, p_note text)
 returns void
 language plpgsql
 security definer
 set search_path to ''
as $$
begin
  perform private.require_platform_admin();
  if not exists (select 1 from public.companies where id = p_company) then
    raise exception 'Company not found.' using errcode = 'P0002';
  end if;
  insert into private.portal_entitlements (company_id, entitled, note, set_by, set_at)
  values (p_company, coalesce(p_entitled, false), left(coalesce(p_note, ''), 500), auth.uid(), now())
  on conflict (company_id) do update set entitled = excluded.entitled, note = excluded.note, set_by = excluded.set_by, set_at = now();
  if not coalesce(p_entitled, false) then
    update public.portal_settings set enabled = false, updated_at = now() where company_id = p_company;
  end if;
  perform private.platform_log('portal.entitlement', 'company', p_company::text,
    case when p_entitled then 'Customer portal entitled' else 'Customer portal entitlement removed' end, jsonb_build_object('note', p_note));
end;
$$;

create or replace function public.platform_portal_entitlement(p_company uuid)
 returns jsonb
 language plpgsql
 stable
 security definer
 set search_path to ''
as $$
begin
  perform private.require_platform_admin();
  return jsonb_build_object('entitled', private.portal_entitled(p_company),
    'enabled', coalesce((select enabled from public.portal_settings where company_id = p_company), false),
    'accounts', (select count(*) from public.portal_accounts where company_id = p_company and status = 'active'),
    'note', coalesce((select note from private.portal_entitlements where company_id = p_company), ''));
end;
$$;

-- Invite a customer contact. Returns the one-time token (shown once to staff; never stored in plain text).
create or replace function public.portal_invite(p_customer uuid, p_contact uuid, p_email text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  v_company uuid := private.require_company();
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_existing public.portal_accounts%rowtype;
  v_token text := private.portal_token();
  v_id uuid;
begin
  perform private.require_permission('customers.edit');
  if not exists (select 1 from public.customers where company_id = v_company and id = p_customer and active) then
    raise exception 'Customer not found.' using errcode = 'P0002';
  end if;
  if p_contact is not null and not exists (select 1 from public.customer_contacts where company_id = v_company and id = p_contact and customer_id = p_customer) then
    raise exception 'Contact not found for this customer.' using errcode = 'P0002';
  end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or length(v_email) > 254 then
    raise exception 'Enter a valid email address.' using errcode = '22023';
  end if;
  select * into v_existing from public.portal_accounts where company_id = v_company and lower(email) = v_email and status <> 'revoked' for update;
  if found then
    if v_existing.customer_id <> p_customer then
      raise exception 'This email already has portal access for another customer.' using errcode = '23505';
    end if;
    if v_existing.status = 'active' then
      raise exception 'This email already has portal access.' using errcode = '23505';
    end if;
    update public.portal_accounts set invite_hash = private.portal_hash(v_token), invite_expires_at = now() + interval '7 days',
      invited_by = auth.uid(), invited_at = now(), contact_id = coalesce(p_contact, contact_id)
    where id = v_existing.id;
    v_id := v_existing.id;
  else
    insert into public.portal_accounts (company_id, customer_id, contact_id, email, invite_hash, invite_expires_at, invited_by)
    values (v_company, p_customer, p_contact, v_email, private.portal_hash(v_token), now() + interval '7 days', auth.uid())
    returning id into v_id;
  end if;
  perform private.log_event('portal.invited', 'portal_account', v_id, format('Portal invitation for %s', v_email), jsonb_build_object('customer_id', p_customer));
  return jsonb_build_object('id', v_id, 'token', v_token, 'expires_at', now() + interval '7 days',
    'slug', (select slug from public.companies where id = v_company));
end;
$$;

create or replace function public.portal_revoke(p_account uuid)
 returns void
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  v_company uuid := private.require_company();
  v public.portal_accounts%rowtype;
begin
  perform private.require_permission('customers.edit');
  update public.portal_accounts set status = 'revoked', revoked_at = now(), revoked_by = auth.uid(), invite_hash = null
  where id = p_account and company_id = v_company and status <> 'revoked'
  returning * into v;
  if not found then
    raise exception 'Portal account not found.' using errcode = 'P0002';
  end if;
  perform private.log_event('portal.revoked', 'portal_account', v.id, format('Portal access removed for %s', v.email), '{}'::jsonb);
end;
$$;

-- Invitation: look up (anyone holding the token) and accept (the signed-in person whose email matches).
create or replace function public.portal_invite_peek(p_token text)
 returns jsonb
 language sql
 stable
 security definer
 set search_path to ''
as $$
  select jsonb_build_object('email', a.email, 'slug', c.slug,
    'company', coalesce(nullif(s.display_name, ''), nullif(cs.company_name, ''), c.name),
    'customer', cu.name, 'expired', a.invite_expires_at < now(), 'open', private.portal_open(c.id))
  from public.portal_accounts a
  join public.companies c on c.id = a.company_id
  join public.customers cu on cu.company_id = a.company_id and cu.id = a.customer_id
  left join public.portal_settings s on s.company_id = c.id
  left join public.company_settings cs on cs.company_id = c.id
  where length(coalesce(p_token, '')) = 64 and a.invite_hash = private.portal_hash(p_token) and a.status = 'invited';
$$;

create or replace function public.portal_accept(p_token text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  v public.portal_accounts%rowtype;
  v_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
begin
  if auth.uid() is null then
    raise exception 'Sign in first.' using errcode = '42501';
  end if;
  select * into v from public.portal_accounts
  where length(coalesce(p_token, '')) = 64 and invite_hash = private.portal_hash(p_token) and status = 'invited' for update;
  if not found or v.invite_expires_at < now() then
    raise exception 'This invitation is not valid. Ask for a new one.' using errcode = '22023';
  end if;
  if lower(v.email) <> v_email then
    raise exception 'This invitation is for a different email address.' using errcode = '42501';
  end if;
  update public.portal_accounts set status = 'active', user_id = auth.uid(), accepted_at = now(), invite_hash = null, invite_expires_at = null
  where id = v.id;
  perform private.portal_log(v.company_id, 'portal.accepted', 'portal_account', v.id, format('%s joined the customer portal', v.email));
  return jsonb_build_object('slug', (select slug from public.companies where id = v.company_id));
end;
$$;

-- Customer: who am I, where can I go ---------------------------------------------------------------------------------
create or replace function public.portal_my_accounts()
 returns jsonb
 language sql
 stable
 security definer
 set search_path to ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('slug', c.slug, 'company', coalesce(nullif(s.display_name, ''), c.name), 'open', private.portal_open(c.id))
                            order by c.name), '[]'::jsonb)
  from public.portal_accounts a join public.companies c on c.id = a.company_id
  left join public.portal_settings s on s.company_id = c.id
  where a.user_id = auth.uid() and a.status = 'active';
$$;

create or replace function public.portal_context(p_slug text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  v public.portal_accounts%rowtype := private.portal_me(p_slug);
begin
  update public.portal_accounts set last_seen_at = now() where id = v.id and (last_seen_at is null or last_seen_at < now() - interval '5 minutes');
  return private.portal_company_card(v.company_id) || jsonb_build_object(
    'customer', (select jsonb_build_object('name', cu.name, 'number', cu.customer_number) from public.customers cu where cu.company_id = v.company_id and cu.id = v.customer_id),
    'email', v.email,
    'sites', (select coalesce(jsonb_agg(jsonb_build_object('id', st.id, 'label', concat_ws(', ', nullif(st.label, ''), nullif(st.city, ''))) order by st.label), '[]'::jsonb)
              from public.customer_sites st where st.company_id = v.company_id and st.customer_id = v.customer_id and st.active));
end;
$$;

-- Public card (no sign-in): only when the company publishes a public portal page.
create or replace function public.portal_public(p_slug text)
 returns jsonb
 language sql
 stable
 security definer
 set search_path to ''
as $$
  select private.portal_company_card(c.id) || jsonb_build_object('public_page', s.public_page)
  from public.companies c join public.portal_settings s on s.company_id = c.id
  where c.slug = p_slug and private.portal_open(c.id);
$$;

-- Customer: orders --------------------------------------------------------------------------------------------------
create or replace function public.portal_orders(p_slug text)
 returns jsonb
 language plpgsql
 stable
 security definer
 set search_path to ''
as $$
declare
  v public.portal_accounts%rowtype := private.portal_me(p_slug);
begin
  perform private.portal_require_feature(v.company_id, 'orders');
  return (select coalesce(jsonb_agg(private.portal_order_summary(o.id) order by coalesce(o.scheduled_start, o.requested_date, o.order_date) desc nulls last, o.created_at desc), '[]'::jsonb)
          from (select o.* from public.orders o
                where o.company_id = v.company_id and o.customer_id = v.customer_id and o.status <> 'draft'
                order by o.created_at desc limit 200) o);
end;
$$;

create or replace function public.portal_order(p_slug text, p_order uuid)
 returns jsonb
 language plpgsql
 stable
 security definer
 set search_path to ''
as $$
declare
  v public.portal_accounts%rowtype := private.portal_me(p_slug);
begin
  perform private.portal_require_feature(v.company_id, 'orders');
  if not exists (select 1 from public.orders o where o.id = p_order and o.company_id = v.company_id and o.customer_id = v.customer_id and o.status <> 'draft') then
    raise exception 'Order not found.' using errcode = 'P0002';
  end if;
  return private.portal_order_summary(p_order) || jsonb_build_object(
    'instructions', (select o.job_instructions from public.orders o where o.id = p_order),
    'total_cents', (select o.total_cents from public.orders o where o.id = p_order),
    'lines', (select coalesce(jsonb_agg(jsonb_build_object('description', l.description, 'quantity', l.quantity, 'unit', coalesce(nullif(l.unit_label, ''), l.unit_code)) order by l.line_no), '[]'::jsonb)
              from public.order_lines l where l.order_id = p_order),
    'loads', (select coalesce(jsonb_agg(jsonb_build_object('number', ld.load_number, 'date', ld.load_date, 'start', ld.start_time, 'end', ld.end_time,
                                                            'quantity', ld.planned_quantity, 'unit', ld.unit_code, 'canceled', ld.status = 'canceled')
                                        order by ld.load_date, ld.start_time nulls last, ld.load_number), '[]'::jsonb)
              from public.order_loads ld where ld.order_id = p_order),
    'tickets', case when private.portal_feature(v.company_id, 'documents') then
              (select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'number', t.ticket_number, 'delivered_at', t.delivered_at, 'quantity', t.quantity, 'unit', t.unit_code,
                                                             'confirmed', t.status = 'accepted') order by t.delivered_at), '[]'::jsonb)
               from public.delivery_tickets t where t.order_id = p_order and t.status in ('submitted', 'needs_review', 'accepted'))
              else '[]'::jsonb end,
    'history', (select coalesce(jsonb_agg(jsonb_build_object('label', private.portal_order_label(e.to_status), 'at', e.occurred_at) order by e.occurred_at), '[]'::jsonb)
                from public.order_status_events e where e.order_id = p_order and e.to_status <> 'draft'));
end;
$$;

-- One delivery ticket (customer copy): the ticket number, order, date, material and quantity. Never driver or truck.
create or replace function public.portal_ticket(p_slug text, p_ticket uuid)
 returns jsonb
 language plpgsql
 stable
 security definer
 set search_path to ''
as $$
declare
  v public.portal_accounts%rowtype := private.portal_me(p_slug);
  r jsonb;
begin
  perform private.portal_require_feature(v.company_id, 'documents');
  select jsonb_build_object('number', t.ticket_number, 'delivered_at', t.delivered_at, 'quantity', t.quantity, 'unit', t.unit_code,
           'confirmed', t.status = 'accepted', 'reference', t.external_reference,
           'material', (select l.description from public.order_lines l where l.id = t.order_line_id),
           'order', jsonb_build_object('number', o.order_number, 'site', concat_ws(', ', nullif(o.site_label, ''), nullif(o.site_line1, ''), nullif(o.site_city, '')),
                                       'project', o.project_name, 'po', o.customer_po))
    into r
  from public.delivery_tickets t join public.orders o on o.id = t.order_id
  where t.id = p_ticket and t.company_id = v.company_id and o.customer_id = v.customer_id and t.status in ('submitted', 'needs_review', 'accepted');
  if r is null then
    raise exception 'Ticket not found.' using errcode = 'P0002';
  end if;
  return r || jsonb_build_object('company', private.portal_company_card(v.company_id) - 'features' - 'welcome' - 'hours',
    'customer', (select cu.name from public.customers cu where cu.company_id = v.company_id and cu.id = v.customer_id));
end;
$$;

-- Customer: quotes --------------------------------------------------------------------------------------------------
create or replace function public.portal_quotes(p_slug text)
 returns jsonb
 language plpgsql
 stable
 security definer
 set search_path to ''
as $$
declare
  v public.portal_accounts%rowtype := private.portal_me(p_slug);
begin
  perform private.portal_require_feature(v.company_id, 'quotes');
  return jsonb_build_object(
    'quotes', (select coalesce(jsonb_agg(jsonb_build_object('id', q.id, 'number', q.quote_number, 'status', q.status, 'sent_at', q.last_sent_at,
                 'valid_until', qv.valid_until, 'project', qv.project_name, 'total_cents', qv.total_cents,
                 'response', (select r.response || ':' || r.status from public.portal_quote_responses r where r.quote_id = q.id order by r.created_at desc limit 1))
               order by q.last_sent_at desc nulls last), '[]'::jsonb)
             from public.quotes q join public.quote_versions qv on qv.company_id = q.company_id and qv.id = q.current_version_id
             where q.company_id = v.company_id and q.customer_id = v.customer_id and q.status in ('sent', 'accepted', 'declined', 'expired') and qv.sent_at is not null),
    'requests', (select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'material', r.material, 'quantity', r.quantity, 'unit', r.unit,
                   'requested_date', r.requested_date, 'status', r.status, 'created_at', r.created_at,
                   'quote_number', (select q.quote_number from public.quotes q where q.id = r.quote_id and q.status <> 'draft'))
                 order by r.created_at desc), '[]'::jsonb)
               from public.portal_quote_requests r where r.company_id = v.company_id and r.customer_id = v.customer_id));
end;
$$;

create or replace function public.portal_quote(p_slug text, p_quote uuid)
 returns jsonb
 language plpgsql
 stable
 security definer
 set search_path to ''
as $$
declare
  v public.portal_accounts%rowtype := private.portal_me(p_slug);
  r jsonb;
begin
  perform private.portal_require_feature(v.company_id, 'quotes');
  select jsonb_build_object('id', q.id, 'number', q.quote_number, 'status', q.status, 'sent_at', q.last_sent_at,
           'valid_until', qv.valid_until, 'quote_date', qv.quote_date, 'project', qv.project_name, 'po', qv.customer_po,
           'site', concat_ws(', ', nullif(qv.site_label, ''), nullif(qv.site_line1, ''), nullif(qv.site_city, '')),
           'terms', qv.terms, 'instructions', qv.job_instructions,
           'subtotal_cents', qv.subtotal_cents, 'discount_cents', qv.discount_cents, 'tax_cents', qv.tax_cents, 'total_cents', qv.total_cents,
           'lines', (select coalesce(jsonb_agg(jsonb_build_object('description', l.description, 'quantity', l.quantity, 'unit', coalesce(nullif(l.unit_label, ''), l.unit_code),
                       'amount_cents', l.amount_cents) order by l.line_no), '[]'::jsonb)
                     from public.quote_lines l where l.company_id = q.company_id and l.quote_version_id = qv.id),
           'can_respond', q.status = 'sent' and (qv.valid_until is null or qv.valid_until >= current_date)
                          and not exists (select 1 from public.portal_quote_responses x where x.quote_id = q.id and x.status = 'pending'),
           'response', (select jsonb_build_object('response', x.response, 'status', x.status, 'at', x.created_at, 'name', x.signer_name)
                        from public.portal_quote_responses x where x.quote_id = q.id order by x.created_at desc limit 1))
    into r
  from public.quotes q join public.quote_versions qv on qv.company_id = q.company_id and qv.id = q.current_version_id
  where q.id = p_quote and q.company_id = v.company_id and q.customer_id = v.customer_id
    and q.status in ('sent', 'accepted', 'declined', 'expired') and qv.sent_at is not null;
  if r is null then
    raise exception 'Quote not found.' using errcode = 'P0002';
  end if;
  return r;
end;
$$;

create or replace function public.portal_quote_respond(p_slug text, p_quote uuid, p_accept boolean, p_name text, p_note text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  v public.portal_accounts%rowtype := private.portal_me(p_slug);
  q public.quotes%rowtype;
  v_valid date;
  v_id uuid;
begin
  perform private.portal_require_feature(v.company_id, 'quotes');
  select * into q from public.quotes where id = p_quote and company_id = v.company_id and customer_id = v.customer_id for update;
  if not found then
    raise exception 'Quote not found.' using errcode = 'P0002';
  end if;
  select valid_until into v_valid from public.quote_versions where company_id = q.company_id and id = q.current_version_id;
  if q.status <> 'sent' then
    raise exception 'This quote can no longer be answered here.' using errcode = '22023';
  end if;
  if v_valid is not null and v_valid < current_date then
    raise exception 'This quote has expired. Ask us for a new one.' using errcode = '22023';
  end if;
  if exists (select 1 from public.portal_quote_responses where quote_id = q.id and status = 'pending') then
    raise exception 'Your answer is already with us.' using errcode = '23505';
  end if;
  perform private.portal_rate(v.id, 'quote_response', 20);
  insert into public.portal_quote_responses (company_id, quote_id, version_id, account_id, response, signer_name, note, created_by)
  values (v.company_id, q.id, q.current_version_id, v.id, case when p_accept then 'accept' else 'decline' end,
          private.clean_text(p_name, 120, 'Name'), private.clean_text(p_note, 1000, 'Note'), auth.uid())
  returning id into v_id;
  perform private.portal_log(v.company_id, 'portal.quote_response', 'quote', q.id,
    format('%s %s quote %s in the customer portal', v.email, case when p_accept then 'accepted' else 'declined' end, q.quote_number));
  return jsonb_build_object('id', v_id);
end;
$$;

-- Duplicate-safe: the same open request (material, quantity, date) within 7 days returns the existing one.
create or replace function public.portal_request_quote(p_slug text, p jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  v public.portal_accounts%rowtype := private.portal_me(p_slug);
  v_material text := private.clean_text(p ->> 'material', 200, 'Material');
  v_qty numeric := nullif(p ->> 'quantity', '')::numeric;
  v_date date := nullif(p ->> 'requested_date', '')::date;
  v_site uuid := nullif(p ->> 'site_id', '')::uuid;
  v_existing uuid;
  v_id uuid;
begin
  perform private.portal_require_feature(v.company_id, 'quotes');
  if length(v_material) = 0 then
    raise exception 'Tell us which material you need.' using errcode = '22023';
  end if;
  if v_qty is not null and (v_qty <= 0 or v_qty >= 1000000) then
    raise exception 'Enter a quantity greater than zero.' using errcode = '22023';
  end if;
  if v_date is not null and v_date < current_date then
    raise exception 'Choose today or a later date.' using errcode = '22023';
  end if;
  if v_site is not null and not exists (select 1 from public.customer_sites where company_id = v.company_id and id = v_site and customer_id = v.customer_id) then
    raise exception 'Site not found.' using errcode = 'P0002';
  end if;
  select id into v_existing from public.portal_quote_requests r
  where r.company_id = v.company_id and r.customer_id = v.customer_id and r.status in ('new', 'reviewing')
    and lower(r.material) = lower(v_material) and r.quantity is not distinct from v_qty and r.requested_date is not distinct from v_date
    and r.created_at > now() - interval '7 days'
  limit 1;
  if v_existing is not null then
    return jsonb_build_object('id', v_existing, 'duplicate', true);
  end if;
  perform private.portal_rate(v.id, 'quote_request', 10);
  insert into public.portal_quote_requests (company_id, customer_id, account_id, site_id, site_text, material, quantity, unit, requested_date, notes, created_by)
  values (v.company_id, v.customer_id, v.id, v_site, private.clean_text(p ->> 'site_text', 300, 'Site'), v_material, v_qty,
          private.clean_text(p ->> 'unit', 30, 'Unit'), v_date, private.clean_text(p ->> 'notes', 2000, 'Notes'), auth.uid())
  returning id into v_id;
  perform private.portal_log(v.company_id, 'portal.quote_requested', 'portal_quote_request', v_id, format('%s requested a quote for %s', v.email, v_material));
  return jsonb_build_object('id', v_id, 'duplicate', false);
end;
$$;

-- Customer: support -------------------------------------------------------------------------------------------------
create or replace function public.portal_support_create(p_slug text, p_subject text, p_message text, p_order uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  v public.portal_accounts%rowtype := private.portal_me(p_slug);
  v_subject text := private.clean_text(p_subject, 160, 'Subject');
  v_message text := private.clean_text(p_message, 4000, 'Message');
  v_id uuid;
begin
  perform private.portal_require_feature(v.company_id, 'support');
  if length(v_subject) = 0 or length(v_message) < 5 then
    raise exception 'Enter a subject and a message.' using errcode = '22023';
  end if;
  if p_order is not null and not exists (select 1 from public.orders where id = p_order and company_id = v.company_id and customer_id = v.customer_id and status <> 'draft') then
    raise exception 'Order not found.' using errcode = 'P0002';
  end if;
  perform private.portal_rate(v.id, 'support', 10);
  insert into public.portal_support_requests (company_id, customer_id, account_id, order_id, subject)
  values (v.company_id, v.customer_id, v.id, p_order, v_subject) returning id into v_id;
  insert into public.portal_messages (company_id, request_id, author_kind, author_id, body) values (v.company_id, v_id, 'customer', auth.uid(), v_message);
  perform private.portal_log(v.company_id, 'portal.support_requested', 'portal_support_request', v_id, format('%s: %s', v.email, v_subject));
  return jsonb_build_object('id', v_id);
end;
$$;

create or replace function public.portal_support_list(p_slug text)
 returns jsonb
 language plpgsql
 stable
 security definer
 set search_path to ''
as $$
declare
  v public.portal_accounts%rowtype := private.portal_me(p_slug);
begin
  perform private.portal_require_feature(v.company_id, 'support');
  return (select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'subject', r.subject, 'status', r.status, 'created_at', r.created_at, 'updated_at', r.updated_at,
            'order_number', (select o.order_number from public.orders o where o.id = r.order_id)) order by r.updated_at desc), '[]'::jsonb)
          from public.portal_support_requests r where r.company_id = v.company_id and r.customer_id = v.customer_id);
end;
$$;

create or replace function public.portal_support_thread(p_slug text, p_request uuid)
 returns jsonb
 language plpgsql
 stable
 security definer
 set search_path to ''
as $$
declare
  v public.portal_accounts%rowtype := private.portal_me(p_slug);
  r jsonb;
begin
  perform private.portal_require_feature(v.company_id, 'support');
  select jsonb_build_object('id', s.id, 'subject', s.subject, 'status', s.status, 'created_at', s.created_at,
           'order_number', (select o.order_number from public.orders o where o.id = s.order_id),
           'messages', (select coalesce(jsonb_agg(jsonb_build_object('from', m.author_kind, 'body', m.body, 'at', m.created_at) order by m.created_at), '[]'::jsonb)
                        from public.portal_messages m where m.request_id = s.id))
    into r
  from public.portal_support_requests s where s.id = p_request and s.company_id = v.company_id and s.customer_id = v.customer_id;
  if r is null then
    raise exception 'Request not found.' using errcode = 'P0002';
  end if;
  return r;
end;
$$;

create or replace function public.portal_support_reply(p_slug text, p_request uuid, p_body text)
 returns void
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  v public.portal_accounts%rowtype := private.portal_me(p_slug);
  v_body text := private.clean_text(p_body, 4000, 'Message');
begin
  perform private.portal_require_feature(v.company_id, 'support');
  if length(v_body) = 0 then
    raise exception 'Enter a message.' using errcode = '22023';
  end if;
  if not exists (select 1 from public.portal_support_requests where id = p_request and company_id = v.company_id and customer_id = v.customer_id) then
    raise exception 'Request not found.' using errcode = 'P0002';
  end if;
  perform private.portal_rate(v.id, 'support_reply', 50);
  insert into public.portal_messages (company_id, request_id, author_kind, author_id, body) values (v.company_id, p_request, 'customer', auth.uid(), v_body);
  update public.portal_support_requests set status = 'open', updated_at = now() where id = p_request;
end;
$$;

-- Customer and public: help -------------------------------------------------------------------------------------------
-- Signed-in customers of the company, or anyone when the company publishes its public page.
create or replace function private.portal_help_company(p_slug text)
 returns uuid
 language plpgsql
 stable
 security definer
 set search_path to ''
as $$
declare
  v_company uuid;
begin
  select c.id into v_company from public.companies c join public.portal_settings s on s.company_id = c.id
  where c.slug = p_slug and private.portal_open(c.id) and s.feature_help;
  if v_company is null then
    raise exception 'Not available.' using errcode = '42501';
  end if;
  if not (select s.public_page from public.portal_settings s where s.company_id = v_company) then
    perform private.portal_me(p_slug);
  end if;
  return v_company;
end;
$$;
revoke all on function private.portal_help_company(text) from public, anon, authenticated;

create or replace function public.portal_help(p_slug text)
 returns jsonb
 language sql
 stable
 security definer
 set search_path to ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'title', a.title, 'category', a.category, 'body', a.body, 'published_at', a.published_at)
                            order by a.category, a.title), '[]'::jsonb)
  from public.portal_help_articles a
  where a.company_id = private.portal_help_company(p_slug) and a.status = 'published';
$$;

create or replace function public.portal_help_vote(p_slug text, p_article uuid, p_helpful boolean)
 returns void
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  v public.portal_accounts%rowtype := private.portal_me(p_slug);
begin
  if not exists (select 1 from public.portal_help_articles where id = p_article and company_id = v.company_id and status = 'published') then
    raise exception 'Article not found.' using errcode = 'P0002';
  end if;
  insert into public.portal_help_feedback (company_id, article_id, account_id, helpful) values (v.company_id, p_article, v.id, p_helpful)
  on conflict (article_id, account_id) do update set helpful = excluded.helpful, created_at = now();
end;
$$;

-- Public tracking ---------------------------------------------------------------------------------------------------
create or replace function public.portal_track(p_token text)
 returns jsonb
 language sql
 stable
 security definer
 set search_path to ''
as $$
  select (private.portal_order_summary(l.order_id) - 'po' - 'project' - 'updated_at')
         || jsonb_build_object('company', private.portal_company_card(l.company_id) - 'features' - 'welcome' - 'hours',
                               'expires_at', l.expires_at,
                               'loads', (select coalesce(jsonb_agg(jsonb_build_object('date', ld.load_date, 'start', ld.start_time, 'end', ld.end_time, 'canceled', ld.status = 'canceled')
                                                                   order by ld.load_date, ld.start_time nulls last), '[]'::jsonb)
                                         from public.order_loads ld where ld.order_id = l.order_id))
  from public.portal_tracking_links l
  join public.orders o on o.id = l.order_id
  where length(coalesce(p_token, '')) = 64 and l.token_hash = private.portal_hash(p_token)
    and l.revoked_at is null and l.expires_at > now() and o.status <> 'draft'
    and private.portal_open(l.company_id) and private.portal_feature(l.company_id, 'tracking');
$$;

-- Staff: work the portal inbox ----------------------------------------------------------------------------------------
create or replace function public.portal_staff_reply(p_request uuid, p_body text, p_close boolean)
 returns void
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  v_company uuid := private.require_company();
  v_body text := private.clean_text(p_body, 4000, 'Reply');
begin
  perform private.require_permission('customers.edit');
  if not exists (select 1 from public.portal_support_requests where id = p_request and company_id = v_company) then
    raise exception 'Request not found.' using errcode = 'P0002';
  end if;
  if length(v_body) > 0 then
    insert into public.portal_messages (company_id, request_id, author_kind, author_id, body) values (v_company, p_request, 'staff', auth.uid(), v_body);
  end if;
  update public.portal_support_requests set status = case when coalesce(p_close, false) then 'closed' when length(v_body) > 0 then 'answered' else status end,
    updated_at = now() where id = p_request;
  perform private.log_event('portal.support_replied', 'portal_support_request', p_request, 'Replied to a portal request', jsonb_build_object('closed', coalesce(p_close, false)));
end;
$$;

create or replace function public.portal_quote_request_update(p_request uuid, p_status text, p_quote uuid, p_note text)
 returns void
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  v_company uuid := private.require_company();
  r public.portal_quote_requests%rowtype;
begin
  perform private.require_permission('quotes.edit');
  select * into r from public.portal_quote_requests where id = p_request and company_id = v_company for update;
  if not found then
    raise exception 'Request not found.' using errcode = 'P0002';
  end if;
  if p_status not in ('new', 'reviewing', 'quoted', 'declined', 'withdrawn') then
    raise exception 'Unknown status.' using errcode = '22023';
  end if;
  if p_quote is not null and not exists (select 1 from public.quotes where id = p_quote and company_id = v_company and customer_id = r.customer_id) then
    raise exception 'That quote belongs to a different customer.' using errcode = '22023';
  end if;
  update public.portal_quote_requests set status = p_status, quote_id = coalesce(p_quote, quote_id),
    staff_note = private.clean_text(p_note, 1000, 'Note'), updated_at = now() where id = p_request;
  perform private.log_event('portal.quote_request_updated', 'portal_quote_request', p_request, format('Quote request marked %s', p_status), '{}'::jsonb);
end;
$$;

-- Confirm or dismiss a customer's quote answer. Confirming an acceptance runs the normal quote workflow.
create or replace function public.portal_quote_response_handle(p_response uuid, p_confirm boolean)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  v_company uuid := private.require_company();
  r public.portal_quote_responses%rowtype;
  v_result jsonb := '{}'::jsonb;
begin
  perform private.require_permission('quotes.status');
  select * into r from public.portal_quote_responses where id = p_response and company_id = v_company and status = 'pending' for update;
  if not found then
    raise exception 'Response not found or already handled.' using errcode = 'P0002';
  end if;
  if p_confirm then
    v_result := public.set_quote_status(r.quote_id, case when r.response = 'accept' then 'accepted' else 'declined' end::public.quote_status,
      left(format('Customer %s in the portal (%s)%s', case when r.response = 'accept' then 'accepted' else 'declined' end, r.signer_name,
                  case when r.note <> '' then ': ' || r.note else '' end), 500));
  end if;
  update public.portal_quote_responses set status = case when p_confirm then 'confirmed' else 'dismissed' end, handled_by = auth.uid(), handled_at = now()
  where id = r.id;
  return v_result;
end;
$$;

create or replace function public.portal_help_save(p_id uuid, p_title text, p_category text, p_body text, p_status text)
 returns uuid
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  v_company uuid := private.require_company();
  v_id uuid;
begin
  perform private.require_permission('settings.manage');
  if p_status not in ('draft', 'published', 'retired') then
    raise exception 'Unknown status.' using errcode = '22023';
  end if;
  if p_id is null then
    insert into public.portal_help_articles (company_id, title, category, body, status, created_by, updated_by, published_by, published_at)
    values (v_company, private.clean_text(p_title, 160, 'Title'), coalesce(nullif(private.clean_text(p_category, 60, 'Category'), ''), 'General'),
            coalesce(p_body, ''), p_status, auth.uid(), auth.uid(),
            case when p_status = 'published' then auth.uid() end, case when p_status = 'published' then now() end)
    returning id into v_id;
  else
    update public.portal_help_articles set title = private.clean_text(p_title, 160, 'Title'),
      category = coalesce(nullif(private.clean_text(p_category, 60, 'Category'), ''), 'General'), body = coalesce(p_body, ''),
      published_by = case when p_status = 'published' and status <> 'published' then auth.uid() else published_by end,
      published_at = case when p_status = 'published' and status <> 'published' then now() else published_at end,
      status = p_status, updated_by = auth.uid(), updated_at = now()
    where id = p_id and company_id = v_company returning id into v_id;
    if v_id is null then
      raise exception 'Article not found.' using errcode = 'P0002';
    end if;
  end if;
  perform private.log_event('portal.help_saved', 'portal_help_article', v_id, format('Customer help article %s (%s)', left(p_title, 80), p_status), '{}'::jsonb);
  return v_id;
end;
$$;

create or replace function public.portal_tracking_create(p_order uuid, p_days integer)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  v_company uuid := private.require_company();
  v_token text := private.portal_token();
  v_id uuid;
  v_days integer := least(greatest(coalesce(p_days, 14), 1), 90);
begin
  perform private.require_permission('orders.edit');
  if not exists (select 1 from public.orders where id = p_order and company_id = v_company and status <> 'draft') then
    raise exception 'Order not found.' using errcode = 'P0002';
  end if;
  insert into public.portal_tracking_links (company_id, order_id, token_hash, expires_at, created_by)
  values (v_company, p_order, private.portal_hash(v_token), now() + make_interval(days => v_days), auth.uid()) returning id into v_id;
  perform private.log_event('portal.tracking_link', 'order', p_order, format('Tracking link created (%s days)', v_days), jsonb_build_object('link', v_id));
  return jsonb_build_object('id', v_id, 'token', v_token, 'expires_at', now() + make_interval(days => v_days));
end;
$$;

create or replace function public.portal_tracking_revoke(p_link uuid)
 returns void
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  v_company uuid := private.require_company();
  v_order uuid;
begin
  perform private.require_permission('orders.edit');
  update public.portal_tracking_links set revoked_at = now() where id = p_link and company_id = v_company and revoked_at is null returning order_id into v_order;
  if v_order is null then
    raise exception 'Link not found.' using errcode = 'P0002';
  end if;
  perform private.log_event('portal.tracking_revoked', 'order', v_order, 'Tracking link revoked', jsonb_build_object('link', p_link));
end;
$$;

-- Grants -------------------------------------------------------------------------------------------------------------
do $$
declare f text;
begin
  foreach f in array array[
    'public.portal_admin_state()', 'public.portal_save_settings(jsonb)', 'public.platform_portal_set_entitlement(uuid,boolean,text)',
    'public.platform_portal_entitlement(uuid)', 'public.portal_invite(uuid,uuid,text)', 'public.portal_revoke(uuid)', 'public.portal_accept(text)',
    'public.portal_my_accounts()', 'public.portal_context(text)', 'public.portal_orders(text)', 'public.portal_order(text,uuid)',
    'public.portal_ticket(text,uuid)', 'public.portal_quotes(text)', 'public.portal_quote(text,uuid)',
    'public.portal_quote_respond(text,uuid,boolean,text,text)', 'public.portal_request_quote(text,jsonb)',
    'public.portal_support_create(text,text,text,uuid)', 'public.portal_support_list(text)', 'public.portal_support_thread(text,uuid)',
    'public.portal_support_reply(text,uuid,text)', 'public.portal_help_vote(text,uuid,boolean)', 'public.portal_staff_reply(uuid,text,boolean)',
    'public.portal_quote_request_update(uuid,text,uuid,text)', 'public.portal_quote_response_handle(uuid,boolean)',
    'public.portal_help_save(uuid,text,text,text,text)', 'public.portal_tracking_create(uuid,integer)', 'public.portal_tracking_revoke(uuid)']
  loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
  -- No sign-in needed: the public card, public help, the invitation preview and tracking (each checks the company's switches).
  foreach f in array array['public.portal_public(text)', 'public.portal_help(text)', 'public.portal_invite_peek(text)', 'public.portal_track(text)']
  loop
    execute format('revoke all on function %s from public', f);
    execute format('grant execute on function %s to anon, authenticated', f);
  end loop;
end $$;
