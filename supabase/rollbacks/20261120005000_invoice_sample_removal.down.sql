-- Rollback for 20261120005000_invoice_sample_removal.sql: invoices block their order's deletion again.
begin;
alter table public.invoice_payments
  drop constraint invoice_payments_company_id_invoice_id_fkey,
  add constraint invoice_payments_company_id_invoice_id_fkey foreign key (company_id, invoice_id) references public.invoices (company_id, id);
alter table public.invoices
  drop constraint invoices_company_id_order_id_fkey,
  add constraint invoices_company_id_order_id_fkey foreign key (company_id, order_id) references public.orders (company_id, id),
  drop constraint invoices_handoff_order_id_fkey,
  add constraint invoices_handoff_order_id_fkey foreign key (handoff_order_id) references public.billing_handoff_orders (id);
drop trigger if exists invoice_payments_delete_guard on public.invoice_payments;
drop trigger if exists invoices_delete_guard on public.invoices;
drop function if exists private.invoice_delete_guard();
commit;
