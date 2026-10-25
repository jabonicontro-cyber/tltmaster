-- =============================================================================
-- QuickBooks Online: customers and invoices (owner authorization 2026-10-25, master plan B82).
--
-- Scope: QuickBooks Online only. A person with billing.manage connects the company's QuickBooks, chooses the product or
-- service item the invoice lines use, and sends billing-handoff orders one at a time or a batch at a time. Nothing is
-- sent automatically, there are no payments and no payroll, and demo companies never send (the app simulates it).
--
--   accounting_connections         one per company: realm (QuickBooks company id), environment, status, the chosen
--                                  item, who connected. No secrets; readable with billing.view.
--   accounting_connection_secrets  the encrypted OAuth tokens. RLS on and no policy: no app user can read or write it;
--                                  only the server (service role) does, after its own permission check. The tokens are
--                                  encrypted by the server before they reach the database.
--   accounting_customer_links      Taviron customer → QuickBooks customer (matched by name or created), readable with
--                                  billing.view.
--   accounting_invoice_sends       one per handoff order: sending → sent | failed, the QuickBooks invoice id and number,
--                                  the totals on both sides (a difference, e.g. sales tax, is recorded, not hidden), the
--                                  attempt count and the last error. One QuickBooks invoice per handoff order.
--
-- Writes go through the functions below (billing.manage, same company); the server calls them as the person.
-- Reversible: supabase/rollbacks/20261120003400_quickbooks.down.sql
-- =============================================================================

create table public.accounting_connections (
  company_id      uuid primary key references public.companies (id),
  provider        text not null default 'qbo' check (provider = 'qbo'),
  environment     text not null check (environment in ('sandbox', 'production')),
  realm_id        text not null check (length(realm_id) between 1 and 40),
  company_name    text not null default '' check (length(company_name) <= 200),
  status          text not null default 'connected' check (status in ('connected', 'needs_reconnect')),
  item_id         text check (item_id is null or length(item_id) <= 40),
  item_name       text not null default '' check (length(item_name) <= 200),
  connected_by    uuid references auth.users (id) on delete set null,
  connected_at    timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table public.accounting_connection_secrets (
  company_id         uuid primary key references public.companies (id) on delete cascade,
  tokens_ciphertext  text not null,
  access_expires_at  timestamptz not null,
  refresh_expires_at timestamptz,
  updated_at         timestamptz not null default now()
);

create table public.accounting_customer_links (
  company_id     uuid not null references public.companies (id),
  customer_id    uuid not null,
  external_id    text not null check (length(external_id) <= 40),
  external_name  text not null default '' check (length(external_name) <= 200),
  created_in_qbo boolean not null default false,
  linked_by      uuid default auth.uid() references auth.users (id) on delete set null,
  linked_at      timestamptz not null default now(),
  primary key (company_id, customer_id),
  foreign key (company_id, customer_id) references public.customers (company_id, id) on delete cascade
);

create table public.accounting_invoice_sends (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null references public.companies (id),
  handoff_order_id   uuid not null references public.billing_handoff_orders (id) on delete cascade,
  status             text not null check (status in ('sending', 'sent', 'failed')),
  simulated          boolean not null default false,
  external_id        text check (external_id is null or length(external_id) <= 40),
  external_number    text not null default '' check (length(external_number) <= 40),
  taviron_total_cents bigint,
  qbo_total_cents    bigint,
  attempts           integer not null default 1 check (attempts >= 1),
  last_error         text not null default '' check (length(last_error) <= 1000),
  requested_by       uuid default auth.uid() references auth.users (id) on delete set null,
  requested_at       timestamptz not null default now(),
  sent_at            timestamptz,
  unique (handoff_order_id)
);
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

-- Record a connection after the OAuth exchange (the server stores the encrypted tokens separately).
create or replace function public.accounting_save_connection(p_environment text, p_realm text, p_company_name text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v_old text;
begin
  perform private.require_permission('billing.manage');
  select realm_id into v_old from public.accounting_connections where company_id = v_company;
  if p_environment not in ('sandbox', 'production') or coalesce(p_realm, '') = '' then
    raise exception 'The QuickBooks connection is incomplete.' using errcode = '22023';
  end if;
  insert into public.accounting_connections (company_id, environment, realm_id, company_name, status, connected_by, connected_at, updated_at)
  values (v_company, p_environment, left(p_realm, 40), left(coalesce(p_company_name, ''), 200), 'connected', auth.uid(), now(), now())
  on conflict (company_id) do update
    set environment = excluded.environment,
        -- A different QuickBooks company forgets the old item choice and customer links.
        item_id = case when public.accounting_connections.realm_id = excluded.realm_id then public.accounting_connections.item_id end,
        item_name = case when public.accounting_connections.realm_id = excluded.realm_id then public.accounting_connections.item_name else '' end,
        realm_id = excluded.realm_id, company_name = excluded.company_name, status = 'connected',
        connected_by = auth.uid(), connected_at = now(), updated_at = now();
  -- Links point at customers in the previous QuickBooks company: forget them.
  if v_old is not null and v_old <> left(p_realm, 40) then
    delete from public.accounting_customer_links l where l.company_id = v_company;
  end if;
end;
$$;
revoke all on function public.accounting_save_connection(text, text, text) from public, anon;
grant execute on function public.accounting_save_connection(text, text, text) to authenticated;

create or replace function public.accounting_set_status(p_status text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.require_permission('billing.manage');
  if p_status not in ('connected', 'needs_reconnect') then raise exception 'Invalid status.' using errcode = '22023'; end if;
  update public.accounting_connections set status = p_status, updated_at = now() where company_id = private.require_company();
end;
$$;
revoke all on function public.accounting_set_status(text) from public, anon;
grant execute on function public.accounting_set_status(text) to authenticated;

create or replace function public.accounting_set_item(p_item_id text, p_item_name text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.require_permission('billing.manage');
  if coalesce(p_item_id, '') = '' then raise exception 'Choose a product or service.' using errcode = '22023'; end if;
  update public.accounting_connections set item_id = left(p_item_id, 40), item_name = left(coalesce(p_item_name, ''), 200), updated_at = now()
   where company_id = private.require_company();
  if not found then raise exception 'QuickBooks is not connected.' using errcode = 'P0002'; end if;
end;
$$;
revoke all on function public.accounting_set_item(text, text) from public, anon;
grant execute on function public.accounting_set_item(text, text) to authenticated;

-- Forget the connection (the server also revokes the tokens at Intuit). Customer links and the send history stay.
create or replace function public.accounting_disconnect()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
begin
  perform private.require_permission('billing.manage');
  delete from public.accounting_connection_secrets where company_id = v_company;
  delete from public.accounting_connections where company_id = v_company;
end;
$$;
revoke all on function public.accounting_disconnect() from public, anon;
grant execute on function public.accounting_disconnect() to authenticated;

create or replace function public.accounting_link_customer(p_customer uuid, p_external_id text, p_external_name text, p_created boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
begin
  perform private.require_permission('billing.manage');
  if not exists (select 1 from public.customers c where c.id = p_customer and c.company_id = v_company) then
    raise exception 'Customer not found.' using errcode = 'P0002';
  end if;
  insert into public.accounting_customer_links (company_id, customer_id, external_id, external_name, created_in_qbo)
  values (v_company, p_customer, left(p_external_id, 40), left(coalesce(p_external_name, ''), 200), coalesce(p_created, false))
  on conflict (company_id, customer_id) do update
    set external_id = excluded.external_id, external_name = excluded.external_name, created_in_qbo = excluded.created_in_qbo,
        linked_by = auth.uid(), linked_at = now();
end;
$$;
revoke all on function public.accounting_link_customer(uuid, text, text, boolean) from public, anon;
grant execute on function public.accounting_link_customer(uuid, text, text, boolean) to authenticated;

-- Claim a send for one handoff order. Returns the send id and whether to go ahead:
--   already sent → go = false (one QuickBooks invoice per handoff order; the existing invoice is reported)
--   another send in progress (under 10 minutes) → go = false
--   new, failed, or an abandoned attempt → go = true (attempts counts up)
-- Undone (reverted) handoff orders cannot be sent.
create or replace function public.accounting_begin_send(p_handoff_order uuid, p_simulated boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v_row public.accounting_invoice_sends%rowtype;
begin
  perform private.require_permission('billing.manage');
  if not exists (select 1 from public.billing_handoff_orders h where h.id = p_handoff_order and h.company_id = v_company and h.reverted_at is null) then
    raise exception 'This order is not in a current billing handoff.' using errcode = 'P0002';
  end if;
  if coalesce(p_simulated, false) is false and not exists (select 1 from public.accounting_connections c where c.company_id = v_company and c.status = 'connected' and c.item_id is not null) then
    raise exception 'Connect QuickBooks and choose the product or service for invoice lines first.' using errcode = 'P0001';
  end if;
  insert into public.accounting_invoice_sends (company_id, handoff_order_id, status, simulated)
  values (v_company, p_handoff_order, 'sending', coalesce(p_simulated, false))
  on conflict (handoff_order_id) do nothing
  returning * into v_row;
  if found then
    return jsonb_build_object('id', v_row.id, 'go', true);
  end if;
  select * into v_row from public.accounting_invoice_sends s where s.handoff_order_id = p_handoff_order for update;
  if v_row.status = 'sent' then
    return jsonb_build_object('id', v_row.id, 'go', false, 'status', 'sent', 'number', v_row.external_number);
  end if;
  if v_row.status = 'sending' and v_row.requested_at > now() - interval '10 minutes' then
    return jsonb_build_object('id', v_row.id, 'go', false, 'status', 'sending');
  end if;
  update public.accounting_invoice_sends
     set status = 'sending', attempts = attempts + 1, requested_by = auth.uid(), requested_at = now(), simulated = coalesce(p_simulated, false)
   where id = v_row.id;
  return jsonb_build_object('id', v_row.id, 'go', true);
end;
$$;
revoke all on function public.accounting_begin_send(uuid, boolean) from public, anon;
grant execute on function public.accounting_begin_send(uuid, boolean) to authenticated;

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
