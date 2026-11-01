-- Rollback for 20261120004800_invoicing.sql (B99). Removes invoices, payments and the invoicing setting, the invoice
-- number sequence and the numbering hooks; the numbering functions return to their 20261120001300 bodies.
-- Invoices already issued and payments recorded are lost by this rollback: export them first (Billing → Invoices)
-- if any real invoice exists. Handoffs, QuickBooks sends and orders are untouched.
begin;
drop trigger if exists accounting_invoice_sends_not_invoiced on public.accounting_invoice_sends;
drop function if exists private.accounting_send_not_invoiced();
drop function if exists public.demo_invoice_samples();
drop function if exists public.invoice_void_payment(uuid, text);
drop function if exists public.invoice_add_payment(uuid, bigint, date, text, text, text);
drop function if exists public.invoice_void(uuid, text);
drop function if exists public.invoice_record_sent(uuid, text[], boolean);
drop function if exists public.invoice_issue(uuid, date);
drop function if exists public.invoice_create(uuid);
drop function if exists public.invoicing_save_settings(text, integer, text);
drop function if exists private.invoice_for_change(uuid);
drop function if exists private.invoice_balance(uuid);
drop table if exists public.invoice_payments;
drop table if exists public.invoices;
drop table if exists public.invoicing_settings;
drop trigger if exists companies_invoice_sequence on public.companies;
drop function if exists private.add_invoice_sequence();
delete from public.document_sequences where key = 'invoice';
alter table public.document_sequences drop constraint document_sequences_key_check;
alter table public.document_sequences add constraint document_sequences_key_check
  check (key in ('customer', 'quote', 'order', 'ticket', 'billing', 'work_order'));

create or replace function private.reference_standard(p_key text, out prefix text, out pad integer, out first_value bigint)
language sql
immutable
set search_path = ''
as $$
  select case p_key
           when 'order' then 'ORD-' when 'quote' then 'QTE-' when 'ticket' then 'TKT-'
           when 'billing' then 'BIL-' when 'customer' then 'CUS-' when 'work_order' then 'MWO-' end,
         4, 1001::bigint;
$$;

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
               when 'billing' then 'billing_handoffs' when 'customer' then 'customers' when 'work_order' then 'work_orders' end,
    case p_key when 'order' then 'order_number' when 'quote' then 'quote_number' when 'ticket' then 'ticket_number'
               when 'billing' then 'batch_number' when 'customer' then 'customer_number' when 'work_order' then 'number' end)
    into v_used using p_company, p_value;
  return v_used;
end;
$$;
revoke all on function private.reference_in_use(uuid, text, text) from public, anon, authenticated;
commit;
