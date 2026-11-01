-- =============================================================================
-- Invoicing and receivables (B99, owner decisions 2026-10-28).
--
-- Each company chooses who issues its invoices (Settings → Invoicing): QuickBooks (the default; nothing changes for
-- companies that send handed-off orders to QuickBooks) or Taviron. When Taviron issues them:
--   * an invoice is made from a handed-off order (its frozen handoff snapshot: lines, totals, PO, service dates),
--     never from live order data, and at most one active invoice exists per handoff;
--   * a draft has no number; issuing locks it, gives it the next invoice number (INV-1001, Settings → Numbering)
--     and its due date (issue date + the company's terms);
--   * the app sends it by email with the company's branding (the database only records that it was sent; a demo
--     company never sends);
--   * payments are recorded against it, never more than what is still owed; a payment or an invoice is voided with a
--     reason, never deleted; an invoice with payments cannot be voided until they are.
-- Nothing is charged, exported or posted to an accounting system here.
--
-- Reads: billing.view. Changes: billing.manage, through the functions below (no table write grants).
-- Reversible: supabase/rollbacks/20261120004800_invoicing.down.sql
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Invoice numbers, like every other document (20261120001300)
-- -----------------------------------------------------------------------------
alter table public.document_sequences drop constraint document_sequences_key_check;
alter table public.document_sequences add constraint document_sequences_key_check
  check (key in ('customer', 'quote', 'order', 'ticket', 'billing', 'work_order', 'invoice'));
insert into public.document_sequences (company_id, key, label, prefix, include_year, pad, next_value)
select id, 'invoice', 'Invoice numbers', 'INV-', false, 4, 1001 from public.companies
on conflict do nothing;

create or replace function private.add_invoice_sequence()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.document_sequences (company_id, key, label, prefix, include_year, pad, next_value)
  values (new.id, 'invoice', 'Invoice numbers', 'INV-', false, 4, 1001)
  on conflict do nothing;
  return new;
end;
$$;
revoke all on function private.add_invoice_sequence() from public, anon, authenticated;
create trigger companies_invoice_sequence after insert on public.companies
  for each row execute function private.add_invoice_sequence();

create or replace function private.reference_standard(p_key text, out prefix text, out pad integer, out first_value bigint)
language sql
immutable
set search_path = ''
as $$
  select case p_key
           when 'order' then 'ORD-' when 'quote' then 'QTE-' when 'ticket' then 'TKT-'
           when 'billing' then 'BIL-' when 'customer' then 'CUS-' when 'work_order' then 'MWO-' when 'invoice' then 'INV-' end,
         4, 1001::bigint;
$$;

-- -----------------------------------------------------------------------------
-- Tables
-- -----------------------------------------------------------------------------
create table public.invoicing_settings (
  company_id  uuid primary key default private.current_company_id() references public.companies (id),
  issuer      text not null default 'quickbooks' check (issuer in ('quickbooks', 'taviron')),
  terms_days  integer not null default 30 check (terms_days between 0 and 120),
  footer      text not null default '' check (length(footer) <= 500),
  updated_by  uuid default auth.uid() references auth.users (id) on delete set null,
  updated_at  timestamptz not null default now()
);

create table public.invoices (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null default private.current_company_id() references public.companies (id),
  number           text,
  status           text not null default 'draft' check (status in ('draft', 'issued', 'void')),
  handoff_order_id uuid not null references public.billing_handoff_orders (id),
  order_id         uuid not null,
  customer_id      uuid not null,
  order_number     text not null,
  customer_po      text not null default '',
  project_name     text not null default '',
  service_start    date,
  service_end      date,
  bill_to          jsonb not null,
  issued_by_entity jsonb,
  lines            jsonb not null,
  subtotal_cents   bigint not null,
  discount_cents   bigint not null default 0,
  tax_cents        bigint not null default 0,
  total_cents      bigint not null check (total_cents >= 0),
  terms_days       integer not null,
  footer           text not null default '',
  issue_date       date,
  due_date         date,
  sent_at          timestamptz,
  sent_to          text[] not null default '{}',
  void_reason      text not null default '',
  created_by       uuid default auth.uid() references auth.users (id) on delete set null,
  created_at       timestamptz not null default now(),
  issued_by        uuid references auth.users (id) on delete set null,
  issued_at        timestamptz,
  voided_by        uuid references auth.users (id) on delete set null,
  voided_at        timestamptz,
  unique (company_id, id),
  foreign key (company_id, order_id) references public.orders (company_id, id),
  foreign key (company_id, customer_id) references public.customers (company_id, id),
  check (status <> 'draft' or number is null),
  check (status <> 'issued' or number is not null),
  check (status = 'draft' or (issue_date is not null and due_date is not null)),
  check ((status = 'void') = (voided_at is not null))
);
create unique index invoices_number on public.invoices (company_id, number) where number is not null;
-- One active invoice per handed-off order: no double invoicing.
create unique index invoices_one_per_handoff on public.invoices (handoff_order_id) where status <> 'void';
create index invoices_company_idx on public.invoices (company_id, status, due_date);
create index invoices_customer_idx on public.invoices (company_id, customer_id);

create table public.invoice_payments (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies (id),
  invoice_id    uuid not null,
  amount_cents  bigint not null check (amount_cents > 0),
  received_on   date not null,
  method        text not null check (method in ('check', 'ach', 'card', 'cash', 'other')),
  reference     text not null default '' check (length(reference) <= 80),
  note          text not null default '' check (length(note) <= 300),
  recorded_by   uuid default auth.uid() references auth.users (id) on delete set null,
  created_at    timestamptz not null default now(),
  voided_at     timestamptz,
  voided_by     uuid references auth.users (id) on delete set null,
  void_reason   text not null default '',
  foreign key (company_id, invoice_id) references public.invoices (company_id, id),
  check ((voided_at is null) = (void_reason = ''))
);
create index invoice_payments_invoice_idx on public.invoice_payments (invoice_id);

alter table public.invoicing_settings enable row level security;
alter table public.invoices enable row level security;
alter table public.invoice_payments enable row level security;
revoke all on public.invoicing_settings, public.invoices, public.invoice_payments from anon, authenticated;
grant select on public.invoicing_settings, public.invoices, public.invoice_payments to authenticated;
create policy invoicing_settings_read on public.invoicing_settings for select to authenticated
  using (company_id = (select private.current_company_id()) and (select private.has_permission('billing.view')));
create policy invoices_read on public.invoices for select to authenticated
  using (company_id = (select private.current_company_id()) and (select private.has_permission('billing.view')));
create policy invoice_payments_read on public.invoice_payments for select to authenticated
  using (company_id = (select private.current_company_id()) and (select private.has_permission('billing.view')));

-- Invoice numbers are never reused (20261120001300).
create or replace function private.reference_in_use(p_company uuid, p_key text, p_value text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_used boolean;
begin
  execute format('select exists (select 1 from public.%I where company_id = $1 and %I = $2)',
    case p_key when 'order' then 'orders' when 'quote' then 'quotes' when 'ticket' then 'delivery_tickets'
               when 'billing' then 'billing_handoffs' when 'customer' then 'customers' when 'work_order' then 'work_orders'
               when 'invoice' then 'invoices' end,
    case p_key when 'order' then 'order_number' when 'quote' then 'quote_number' when 'ticket' then 'ticket_number'
               when 'billing' then 'batch_number' when 'customer' then 'customer_number' when 'work_order' then 'number'
               when 'invoice' then 'number' end)
    into v_used using p_company, p_value;
  return v_used;
end;
$$;
revoke all on function private.reference_in_use(uuid, text, text) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Helpers (internal)
-- -----------------------------------------------------------------------------

-- What is still owed on an invoice (total less active payments).
create or replace function private.invoice_balance(p_invoice uuid)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select i.total_cents - coalesce((select sum(p.amount_cents) from public.invoice_payments p where p.invoice_id = i.id and p.voided_at is null), 0)
    from public.invoices i where i.id = p_invoice;
$$;
revoke all on function private.invoice_balance(uuid) from public, anon, authenticated;

-- An invoice of the caller's company, locked, for a change (billing.manage).
create or replace function private.invoice_for_change(p_invoice uuid)
returns public.invoices
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.invoices%rowtype;
begin
  perform private.require_permission('billing.manage');
  select * into v from public.invoices where id = p_invoice and company_id = private.require_company() for update;
  if not found then
    raise exception 'Invoice not found.' using errcode = 'P0002';
  end if;
  return v;
end;
$$;
revoke all on function private.invoice_for_change(uuid) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Settings
-- -----------------------------------------------------------------------------
create or replace function public.invoicing_save_settings(p_issuer text, p_terms_days integer, p_footer text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v_footer text := private.clean_text(p_footer, 500, 'Footer');
begin
  perform private.require_permission('billing.manage');
  if p_issuer not in ('quickbooks', 'taviron') then
    raise exception 'Choose who issues your invoices.' using errcode = '22023';
  end if;
  if p_terms_days is null or p_terms_days not between 0 and 120 then
    raise exception 'Payment terms are 0 to 120 days.' using errcode = '22023';
  end if;
  insert into public.invoicing_settings (company_id, issuer, terms_days, footer) values (v_company, p_issuer, p_terms_days, v_footer)
  on conflict (company_id) do update set issuer = excluded.issuer, terms_days = excluded.terms_days, footer = excluded.footer,
    updated_by = auth.uid(), updated_at = now();
  perform private.log_event('invoicing.settings', 'company', v_company,
    format('Invoices are issued by %s; terms %s days', case p_issuer when 'taviron' then 'Taviron' else 'QuickBooks' end, p_terms_days),
    jsonb_build_object('issuer', p_issuer, 'terms_days', p_terms_days));
end;
$$;

-- -----------------------------------------------------------------------------
-- Invoices
-- -----------------------------------------------------------------------------

-- A draft invoice from a handed-off order. Refused when QuickBooks issues the company's invoices, when the handoff was
-- undone, when an active invoice exists, or when the order was already sent to QuickBooks.
create or replace function public.invoice_create(p_handoff_order uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v_settings public.invoicing_settings%rowtype;
  h public.billing_handoff_orders%rowtype;
  c public.customers%rowtype;
  o jsonb;
  v_entity jsonb;
  v_id uuid;
begin
  perform private.require_permission('billing.manage');
  select * into v_settings from public.invoicing_settings where company_id = v_company;
  if coalesce(v_settings.issuer, 'quickbooks') <> 'taviron' then
    raise exception 'Your company issues invoices in QuickBooks. To issue them from Taviron, change it in Settings → Invoicing.' using errcode = '22023';
  end if;
  select * into h from public.billing_handoff_orders where id = p_handoff_order and company_id = v_company;
  if not found then
    raise exception 'Handed-off order not found.' using errcode = 'P0002';
  end if;
  if h.reverted_at is not null then
    raise exception 'This handoff was undone. Hand the order off again to invoice it.' using errcode = '22023';
  end if;
  if exists (select 1 from public.invoices i where i.handoff_order_id = h.id and i.status <> 'void') then
    raise exception 'This order already has an invoice.' using errcode = '23505';
  end if;
  if exists (select 1 from public.accounting_invoice_sends s where s.handoff_order_id = h.id and s.status = 'sent' and not s.simulated) then
    raise exception 'This order was already sent to QuickBooks as an invoice.' using errcode = '23505';
  end if;
  o := h.snapshot -> 'order';
  select cu.* into c from public.customers cu join public.orders od on od.customer_id = cu.id
   where od.id = h.order_id and od.company_id = v_company;
  select jsonb_build_object('name', coalesce(nullif(e.legal_name, ''), e.name), 'address_line1', e.address_line1, 'address_line2', e.address_line2,
                            'city', e.city, 'region', e.region, 'postal_code', e.postal_code, 'phone', e.phone, 'email', e.email)
    into v_entity from public.billing_entities e where e.company_id = v_company and e.is_default and e.active;
  insert into public.invoices (company_id, handoff_order_id, order_id, customer_id, order_number, customer_po, project_name,
                               service_start, service_end, bill_to, issued_by_entity, lines, subtotal_cents, discount_cents,
                               tax_cents, total_cents, terms_days, footer)
  values (v_company, h.id, h.order_id, c.id, o ->> 'order_number', coalesce(o ->> 'customer_po', ''), coalesce(o ->> 'project_name', ''),
          (o ->> 'service_start')::date, (o ->> 'service_end')::date,
          jsonb_build_object('name', c.name, 'customer_number', c.customer_number, 'email', c.email, 'line1', c.billing_line1,
                             'line2', c.billing_line2, 'city', c.billing_city, 'state', c.billing_state, 'postal_code', c.billing_postal_code),
          v_entity, coalesce(h.snapshot -> 'lines', '[]'::jsonb),
          coalesce((o ->> 'subtotal_cents')::bigint, 0), coalesce((o ->> 'discount_cents')::bigint, 0), coalesce((o ->> 'tax_cents')::bigint, 0),
          coalesce((o ->> 'total_cents')::bigint, 0), coalesce(v_settings.terms_days, 30), coalesce(v_settings.footer, ''))
  returning id into v_id;
  perform private.log_event('invoice.created', 'invoice', v_id, format('Draft invoice for order %s', o ->> 'order_number'), '{}'::jsonb);
  return v_id;
end;
$$;

-- Issue a draft: it is locked, numbered and given its due date.
create or replace function public.invoice_issue(p_invoice uuid, p_issue_date date default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.invoices%rowtype := private.invoice_for_change(p_invoice);
  v_today date := private.company_today(v.company_id);
  v_date date := coalesce(p_issue_date, v_today);
  v_number text;
begin
  if v.status <> 'draft' then
    raise exception 'Only a draft can be issued.' using errcode = '22023';
  end if;
  if v_date > v_today or v_date < v_today - 90 then
    raise exception 'The issue date is today or up to 90 days earlier.' using errcode = '22023';
  end if;
  v_number := private.next_document_number(v.company_id, 'invoice');
  update public.invoices set status = 'issued', number = v_number, issue_date = v_date, due_date = v_date + v.terms_days,
         issued_by = auth.uid(), issued_at = now()
   where id = v.id;
  perform private.log_event('invoice.issued', 'invoice', v.id, format('Invoice %s issued for order %s', v_number, v.order_number),
    jsonb_build_object('number', v_number, 'total_cents', v.total_cents));
  return jsonb_build_object('number', v_number, 'due_date', v_date + v.terms_days);
end;
$$;

-- Record that the invoice was emailed (the app sends; a preview or a demo is recorded as simulated, never as sent).
create or replace function public.invoice_record_sent(p_invoice uuid, p_to text[], p_simulated boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.invoices%rowtype := private.invoice_for_change(p_invoice);
begin
  if v.status <> 'issued' then
    raise exception 'Only an issued invoice can be sent.' using errcode = '22023';
  end if;
  if not p_simulated then
    update public.invoices set sent_at = now(), sent_to = coalesce(p_to, '{}') where id = v.id;
  end if;
  perform private.log_event(case when p_simulated then 'invoice.preview' else 'invoice.sent' end, 'invoice', v.id,
    format(case when p_simulated then 'Invoice %s email previewed (not sent) for %s' else 'Invoice %s emailed to %s' end,
           v.number, array_to_string(coalesce(p_to, '{}'), ', ')),
    jsonb_build_object('to', coalesce(p_to, '{}'), 'simulated', p_simulated));
end;
$$;

create or replace function public.invoice_void(p_invoice uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.invoices%rowtype := private.invoice_for_change(p_invoice);
  v_reason text := private.clean_text(p_reason, 300, 'Reason');
begin
  if v.status = 'void' then
    raise exception 'This invoice is already void.' using errcode = '22023';
  end if;
  if v_reason = '' then
    raise exception 'Give a reason for voiding the invoice.' using errcode = '22023';
  end if;
  if exists (select 1 from public.invoice_payments p where p.invoice_id = v.id and p.voided_at is null) then
    raise exception 'This invoice has payments. Void the payments first.' using errcode = '22023';
  end if;
  -- A voided draft keeps no number; a voided issued invoice keeps its number (never reused).
  update public.invoices set status = 'void', void_reason = v_reason, voided_by = auth.uid(), voided_at = now() where id = v.id;
  perform private.log_event('invoice.voided', 'invoice', v.id, format('Invoice %s voided: %s', coalesce(v.number, 'draft'), v_reason), '{}'::jsonb);
end;
$$;

create or replace function public.invoice_add_payment(p_invoice uuid, p_amount_cents bigint, p_received_on date, p_method text,
                                                      p_reference text default '', p_note text default '')
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.invoices%rowtype := private.invoice_for_change(p_invoice);
  v_balance bigint;
  v_id uuid;
begin
  if v.status <> 'issued' then
    raise exception 'Payments are recorded on issued invoices only.' using errcode = '22023';
  end if;
  if p_amount_cents is null or p_amount_cents <= 0 then
    raise exception 'Enter the amount received.' using errcode = '22023';
  end if;
  v_balance := private.invoice_balance(v.id);
  if p_amount_cents > v_balance then
    raise exception 'That is more than the % still owed.', to_char(v_balance / 100.0, 'FM$999,999,990.00') using errcode = '22023';
  end if;
  if p_received_on is null or p_received_on > private.company_today(v.company_id) or p_received_on < v.issue_date - 30 then
    raise exception 'Enter the date the payment was received (not in the future).' using errcode = '22023';
  end if;
  if p_method not in ('check', 'ach', 'card', 'cash', 'other') then
    raise exception 'Choose how it was paid.' using errcode = '22023';
  end if;
  insert into public.invoice_payments (company_id, invoice_id, amount_cents, received_on, method, reference, note)
  values (v.company_id, v.id, p_amount_cents, p_received_on, p_method, private.clean_text(p_reference, 80, 'Reference'), private.clean_text(p_note, 300, 'Note'))
  returning id into v_id;
  perform private.log_event('invoice.payment', 'invoice', v.id,
    format('Payment of %s recorded on invoice %s', to_char(p_amount_cents / 100.0, 'FM$999,999,990.00'), v.number),
    jsonb_build_object('amount_cents', p_amount_cents, 'method', p_method));
  return v_id;
end;
$$;

create or replace function public.invoice_void_payment(p_payment uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  p public.invoice_payments%rowtype;
  v public.invoices%rowtype;
  v_reason text := private.clean_text(p_reason, 300, 'Reason');
begin
  perform private.require_permission('billing.manage');
  select * into p from public.invoice_payments where id = p_payment and company_id = private.require_company() for update;
  if not found then
    raise exception 'Payment not found.' using errcode = 'P0002';
  end if;
  if p.voided_at is not null then
    raise exception 'This payment is already void.' using errcode = '22023';
  end if;
  if v_reason = '' then
    raise exception 'Give a reason for voiding the payment.' using errcode = '22023';
  end if;
  update public.invoice_payments set voided_at = now(), voided_by = auth.uid(), void_reason = v_reason where id = p.id;
  select * into v from public.invoices where id = p.invoice_id;
  perform private.log_event('invoice.payment_voided', 'invoice', v.id,
    format('Payment of %s on invoice %s voided: %s', to_char(p.amount_cents / 100.0, 'FM$999,999,990.00'), v.number, v_reason), '{}'::jsonb);
end;
$$;

-- No double invoicing the other way: a real QuickBooks send is refused for an order Taviron already invoiced.
create or replace function private.accounting_send_not_invoiced()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not new.simulated and exists (select 1 from public.invoices i where i.handoff_order_id = new.handoff_order_id and i.status <> 'void') then
    raise exception 'This order already has a Taviron invoice. Void it before sending the order to QuickBooks.' using errcode = '23505';
  end if;
  return new;
end;
$$;
revoke all on function private.accounting_send_not_invoiced() from public, anon, authenticated;
create trigger accounting_invoice_sends_not_invoiced before insert on public.accounting_invoice_sends
  for each row execute function private.accounting_send_not_invoiced();

-- -----------------------------------------------------------------------------
-- Demo sample: Taviron issues the demo's invoices; up to three handed-off orders become invoices — one past due and
-- unpaid, one partly paid, one paid — so Invoices and Receivables show every state. Fictional; nothing is sent.
-- -----------------------------------------------------------------------------
create or replace function public.demo_invoice_samples()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_demo uuid := private.demo_owner_company();
  v_today date;
  r record;
  v_inv uuid;
  v_total bigint;
  v_ready uuid[];
  n integer := 0;
begin
  if v_demo is null then
    raise exception 'Demo samples are only added to a demo company, by its owner.' using errcode = '42501';
  end if;
  if exists (select 1 from public.invoices where company_id = v_demo) then
    return 0;
  end if;
  v_today := private.company_today(v_demo);
  insert into public.invoicing_settings (company_id, issuer, terms_days, footer)
  values (v_demo, 'taviron', 30, 'Thank you for your business. Demo company: this invoice is fictional.')
  on conflict (company_id) do nothing;
  -- Up to three handed-off orders: hand off ready demo orders when there are fewer (as the office would), keeping one ready.
  select array_agg(order_id) into v_ready from (
    select s.order_id from public.billing_order_status s
     where s.company_id = v_demo and s.readiness = 'ready'
     order by s.order_number
     limit greatest(0, least(3 - (select count(*) from public.billing_handoff_orders h where h.company_id = v_demo and h.reverted_at is null),
                             -- always leave one order ready to bill, so Billing still shows that state
                             (select count(*) from public.billing_order_status rs where rs.company_id = v_demo and rs.readiness = 'ready') - 1))) x;
  if coalesce(cardinality(v_ready), 0) > 0 then
    perform public.hand_off_orders(v_ready, 'Demo invoices', 'Handed off so the demo has invoices to show.', gen_random_uuid());
  end if;
  for r in select h.id from public.billing_handoff_orders h
            where h.company_id = v_demo and h.reverted_at is null
              and not exists (select 1 from public.accounting_invoice_sends s where s.handoff_order_id = h.id and s.status = 'sent' and not s.simulated)
            order by h.id limit 3 loop
    v_inv := public.invoice_create(r.id);
    perform public.invoice_issue(v_inv, v_today - case n when 0 then 45 when 1 then 12 else 20 end);
    select total_cents into v_total from public.invoices where id = v_inv;
    if n = 1 and v_total > 1 then
      perform public.invoice_add_payment(v_inv, v_total / 2, v_today - 3, 'check', '1042', 'Partial payment (demo)');
    elsif n = 2 and v_total > 0 then
      perform public.invoice_add_payment(v_inv, v_total, v_today - 5, 'ach', '', 'Paid in full (demo)');
    end if;
    n := n + 1;
  end loop;
  return n;
end;
$$;

revoke all on function public.invoicing_save_settings(text, integer, text), public.invoice_create(uuid), public.invoice_issue(uuid, date),
  public.invoice_record_sent(uuid, text[], boolean), public.invoice_void(uuid, text),
  public.invoice_add_payment(uuid, bigint, date, text, text, text), public.invoice_void_payment(uuid, text),
  public.demo_invoice_samples() from public, anon;
grant execute on function public.invoicing_save_settings(text, integer, text), public.invoice_create(uuid), public.invoice_issue(uuid, date),
  public.invoice_record_sent(uuid, text[], boolean), public.invoice_void(uuid, text),
  public.invoice_add_payment(uuid, bigint, date, text, text, text), public.invoice_void_payment(uuid, text),
  public.demo_invoice_samples() to authenticated;
