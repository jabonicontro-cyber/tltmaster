-- =============================================================================
-- QuickBooks Online: customers and invoices (owner authorization 2026-10-25, master plan B82), one QuickBooks company
-- per billing entity (owner 2026-10-25: Top Line Stone & Sand and Top Line Trucking each have their own QuickBooks).
--
-- Scope: QuickBooks Online only. A person with billing.manage connects a business's QuickBooks, chooses the product or
-- service item its invoice lines use, and sends billing-handoff orders. Each order becomes one invoice per business
-- that has lines on it (materials to one QuickBooks, delivery to the other). Nothing is sent automatically, there are
-- no payments and no payroll, and demo companies never send (the app simulates it).
--
--   accounting_connections         one per business (billing entity), or one for the whole company when it has no
--                                  businesses set up: QuickBooks company id, environment, status, chosen item. No secrets;
--                                  readable with billing.view.
--   accounting_connection_secrets  the encrypted OAuth tokens. RLS on and no policy: no app user can read or write it;
--                                  only the server (service role) does, after its own permission check.
--   accounting_customer_links      per connection: Taviron customer → QuickBooks customer (matched by name or created).
--   accounting_invoice_sends       per handoff order and business: sending → sent | failed, the QuickBooks invoice, totals
--                                  on both sides (a difference, e.g. sales tax, is recorded), attempts, last error.
--
-- Writes go through the functions below (billing.manage, same company). Reversible:
-- supabase/rollbacks/20261120003500_quickbooks.down.sql
-- =============================================================================

create table public.accounting_connections (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null references public.companies (id),
  billing_entity_id  uuid,
  provider           text not null default 'qbo' check (provider = 'qbo'),
  environment        text not null check (environment in ('sandbox', 'production')),
  realm_id           text not null check (length(realm_id) between 1 and 40),
  company_name       text not null default '' check (length(company_name) <= 200),
  status             text not null default 'connected' check (status in ('connected', 'needs_reconnect')),
  item_id            text check (item_id is null or length(item_id) <= 40),
  item_name          text not null default '' check (length(item_name) <= 200),
  connected_by       uuid references auth.users (id) on delete set null,
  connected_at       timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (company_id, id),
  foreign key (company_id, billing_entity_id) references public.billing_entities (company_id, id) on delete cascade
);
create unique index accounting_connections_one_per_entity on public.accounting_connections (company_id, coalesce(billing_entity_id, '00000000-0000-0000-0000-000000000000'::uuid));

create table public.accounting_connection_secrets (
  connection_id      uuid primary key references public.accounting_connections (id) on delete cascade,
  company_id         uuid not null references public.companies (id),
  tokens_ciphertext  text not null,
  access_expires_at  timestamptz not null,
  refresh_expires_at timestamptz,
  updated_at         timestamptz not null default now()
);

create table public.accounting_customer_links (
  connection_id  uuid not null references public.accounting_connections (id) on delete cascade,
  company_id     uuid not null references public.companies (id),
  customer_id    uuid not null,
  external_id    text not null check (length(external_id) <= 40),
  external_name  text not null default '' check (length(external_name) <= 200),
  created_in_qbo boolean not null default false,
  linked_by      uuid default auth.uid() references auth.users (id) on delete set null,
  linked_at      timestamptz not null default now(),
  primary key (connection_id, customer_id),
  foreign key (company_id, customer_id) references public.customers (company_id, id) on delete cascade
);

create table public.accounting_invoice_sends (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null references public.companies (id),
  handoff_order_id    uuid not null references public.billing_handoff_orders (id) on delete cascade,
  billing_entity_id   uuid,
  status              text not null check (status in ('sending', 'sent', 'failed')),
  simulated           boolean not null default false,
  external_id         text check (external_id is null or length(external_id) <= 40),
  external_number     text not null default '' check (length(external_number) <= 40),
  taviron_total_cents bigint,
  qbo_total_cents     bigint,
  attempts            integer not null default 1 check (attempts >= 1),
  last_error          text not null default '' check (length(last_error) <= 1000),
  requested_by        uuid default auth.uid() references auth.users (id) on delete set null,
  requested_at        timestamptz not null default now(),
  sent_at             timestamptz
);
create unique index accounting_invoice_sends_one on public.accounting_invoice_sends (handoff_order_id, coalesce(billing_entity_id, '00000000-0000-0000-0000-000000000000'::uuid));
create index accounting_invoice_sends_company_idx on public.accounting_invoice_sends (company_id, requested_at desc);

alter table public.accounting_connections enable row level security;
alter table public.accounting_connection_secrets enable row level security;
alter table public.accounting_customer_links enable row level security;
alter table public.accounting_invoice_sends enable row level security;
revoke all on public.accounting_connections, public.accounting_connection_secrets, public.accounting_customer_links,
  public.accounting_invoice_sends from anon, authenticated;
grant select on public.accounting_connections, public.accounting_customer_links, public.accounting_invoice_sends to authenticated;
-- accounting_connection_secrets: no grant and no policy for app users (service role only).

create policy accounting_connections_read on public.accounting_connections for select to authenticated
  using (company_id = (select private.current_company_id()) and (select private.has_permission('billing.view')));
create policy accounting_customer_links_read on public.accounting_customer_links for select to authenticated
  using (company_id = (select private.current_company_id()) and (select private.has_permission('billing.view')));
create policy accounting_invoice_sends_read on public.accounting_invoice_sends for select to authenticated
  using (company_id = (select private.current_company_id()) and (select private.has_permission('billing.view')));

-- The connection for a business (or the whole company when p_entity is null), checked against the caller's company.
create or replace function private.accounting_connection(p_entity uuid)
returns public.accounting_connections
language sql
stable
security definer
set search_path = ''
as $$
  select c.* from public.accounting_connections c
  where c.company_id = private.current_company_id() and c.billing_entity_id is not distinct from p_entity;
$$;
revoke all on function private.accounting_connection(uuid) from public, anon, authenticated;

-- Record a connection after the OAuth exchange; returns its id (the server stores the encrypted tokens under it).
-- A different QuickBooks company for the same business forgets the old item choice and customer links.
create or replace function public.accounting_save_connection(p_entity uuid, p_environment text, p_realm text, p_company_name text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v_old public.accounting_connections%rowtype := private.accounting_connection(p_entity);
  v_id uuid;
begin
  perform private.require_permission('billing.manage');
  if p_environment not in ('sandbox', 'production') or coalesce(p_realm, '') = '' then
    raise exception 'The QuickBooks connection is incomplete.' using errcode = '22023';
  end if;
  if p_entity is not null and not exists (select 1 from public.billing_entities e where e.id = p_entity and e.company_id = v_company) then
    raise exception 'Business not found.' using errcode = 'P0002';
  end if;
  if v_old.id is null then
    insert into public.accounting_connections (company_id, billing_entity_id, environment, realm_id, company_name, connected_by)
    values (v_company, p_entity, p_environment, left(p_realm, 40), left(coalesce(p_company_name, ''), 200), auth.uid())
    returning id into v_id;
  else
    v_id := v_old.id;
    update public.accounting_connections
       set environment = p_environment, realm_id = left(p_realm, 40), company_name = left(coalesce(p_company_name, ''), 200),
           status = 'connected', connected_by = auth.uid(), connected_at = now(), updated_at = now(),
           item_id = case when v_old.realm_id = left(p_realm, 40) then item_id end,
           item_name = case when v_old.realm_id = left(p_realm, 40) then item_name else '' end
     where id = v_id;
    if v_old.realm_id <> left(p_realm, 40) then
      delete from public.accounting_customer_links l where l.connection_id = v_id;
    end if;
  end if;
  return v_id;
end;
$$;
revoke all on function public.accounting_save_connection(uuid, text, text, text) from public, anon;
grant execute on function public.accounting_save_connection(uuid, text, text, text) to authenticated;

create or replace function public.accounting_set_status(p_connection uuid, p_status text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.require_permission('billing.manage');
  if p_status not in ('connected', 'needs_reconnect') then raise exception 'Invalid status.' using errcode = '22023'; end if;
  update public.accounting_connections set status = p_status, updated_at = now() where id = p_connection and company_id = private.require_company();
end;
$$;
revoke all on function public.accounting_set_status(uuid, text) from public, anon;
grant execute on function public.accounting_set_status(uuid, text) to authenticated;

create or replace function public.accounting_set_item(p_connection uuid, p_item_id text, p_item_name text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.require_permission('billing.manage');
  if coalesce(p_item_id, '') = '' then raise exception 'Choose a product or service.' using errcode = '22023'; end if;
  update public.accounting_connections set item_id = left(p_item_id, 40), item_name = left(coalesce(p_item_name, ''), 200), updated_at = now()
   where id = p_connection and company_id = private.require_company();
  if not found then raise exception 'QuickBooks is not connected.' using errcode = 'P0002'; end if;
end;
$$;
revoke all on function public.accounting_set_item(uuid, text, text) from public, anon;
grant execute on function public.accounting_set_item(uuid, text, text) to authenticated;

-- Forget a connection (the server also revokes the tokens at Intuit). Its customer links go with it; the send history
-- stays.
create or replace function public.accounting_disconnect(p_connection uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.require_permission('billing.manage');
  delete from public.accounting_connections where id = p_connection and company_id = private.require_company();
end;
$$;
revoke all on function public.accounting_disconnect(uuid) from public, anon;
grant execute on function public.accounting_disconnect(uuid) to authenticated;

create or replace function public.accounting_link_customer(p_connection uuid, p_customer uuid, p_external_id text, p_external_name text, p_created boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
begin
  perform private.require_permission('billing.manage');
  if not exists (select 1 from public.accounting_connections c where c.id = p_connection and c.company_id = v_company)
     or not exists (select 1 from public.customers c where c.id = p_customer and c.company_id = v_company) then
    raise exception 'Customer or connection not found.' using errcode = 'P0002';
  end if;
  insert into public.accounting_customer_links (connection_id, company_id, customer_id, external_id, external_name, created_in_qbo)
  values (p_connection, v_company, p_customer, left(p_external_id, 40), left(coalesce(p_external_name, ''), 200), coalesce(p_created, false))
  on conflict (connection_id, customer_id) do update
    set external_id = excluded.external_id, external_name = excluded.external_name, created_in_qbo = excluded.created_in_qbo,
        linked_by = auth.uid(), linked_at = now();
end;
$$;
revoke all on function public.accounting_link_customer(uuid, uuid, text, text, boolean) from public, anon;
grant execute on function public.accounting_link_customer(uuid, uuid, text, text, boolean) to authenticated;

-- Claim a send for one handoff order and business (p_entity null = the whole company). Returns:
--   already sent → go = false (one QuickBooks invoice per order and business; the existing invoice is reported)
--   another send in progress (under 10 minutes) → go = false
--   new, failed, or an abandoned attempt → go = true (attempts counts up)
-- Undone (reverted) handoff orders cannot be sent; a real send needs a connected business with its item chosen.
create or replace function public.accounting_begin_send(p_handoff_order uuid, p_entity uuid, p_simulated boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v_row public.accounting_invoice_sends%rowtype;
  v_conn public.accounting_connections%rowtype := private.accounting_connection(p_entity);
begin
  perform private.require_permission('billing.manage');
  -- Only a demo company records simulated sends; a real company's send always goes to its QuickBooks.
  if coalesce(p_simulated, false) and not exists (select 1 from public.companies c where c.id = v_company and c.is_demo) then
    raise exception 'Only demo companies simulate sends.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.billing_handoff_orders h where h.id = p_handoff_order and h.company_id = v_company and h.reverted_at is null) then
    raise exception 'This order is not in a current billing handoff.' using errcode = 'P0002';
  end if;
  if coalesce(p_simulated, false) is false and (v_conn.id is null or v_conn.status <> 'connected' or v_conn.item_id is null) then
    raise exception 'Connect QuickBooks for this business and choose the product or service for invoice lines first.' using errcode = 'P0001';
  end if;
  select * into v_row from public.accounting_invoice_sends s
   where s.handoff_order_id = p_handoff_order and s.billing_entity_id is not distinct from p_entity for update;
  if not found then
    insert into public.accounting_invoice_sends (company_id, handoff_order_id, billing_entity_id, status, simulated)
    values (v_company, p_handoff_order, p_entity, 'sending', coalesce(p_simulated, false))
    returning * into v_row;
    return jsonb_build_object('id', v_row.id, 'go', true, 'connection', v_conn.id);
  end if;
  if v_row.status = 'sent' then
    return jsonb_build_object('id', v_row.id, 'go', false, 'status', 'sent', 'number', v_row.external_number);
  end if;
  if v_row.status = 'sending' and v_row.requested_at > now() - interval '10 minutes' then
    return jsonb_build_object('id', v_row.id, 'go', false, 'status', 'sending');
  end if;
  update public.accounting_invoice_sends
     set status = 'sending', attempts = attempts + 1, requested_by = auth.uid(), requested_at = now(), simulated = coalesce(p_simulated, false)
   where id = v_row.id;
  return jsonb_build_object('id', v_row.id, 'go', true, 'connection', v_conn.id);
end;
$$;
revoke all on function public.accounting_begin_send(uuid, uuid, boolean) from public, anon;
grant execute on function public.accounting_begin_send(uuid, uuid, boolean) to authenticated;

create or replace function public.accounting_finish_send(p_send uuid, p_ok boolean, p_external_id text, p_external_number text,
                                                        p_taviron_total bigint, p_qbo_total bigint, p_error text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.require_permission('billing.manage');
  update public.accounting_invoice_sends
     set status = case when p_ok then 'sent' else 'failed' end,
         external_id = case when p_ok then left(p_external_id, 40) else external_id end,
         external_number = case when p_ok then left(coalesce(p_external_number, ''), 40) else external_number end,
         taviron_total_cents = p_taviron_total, qbo_total_cents = p_qbo_total,
         last_error = case when p_ok then '' else left(coalesce(p_error, 'The send failed.'), 1000) end,
         sent_at = case when p_ok then now() else sent_at end
   where id = p_send and company_id = private.require_company() and status = 'sending';
  if not found then raise exception 'This send is not in progress.' using errcode = 'P0002'; end if;
end;
$$;
revoke all on function public.accounting_finish_send(uuid, boolean, text, text, bigint, bigint, text) from public, anon;
grant execute on function public.accounting_finish_send(uuid, boolean, text, text, bigint, bigint, text) to authenticated;
