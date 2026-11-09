-- Rollback of 20261120009700_ticket_payment_sample_removal: the foreign keys go back to refusing the delete (Remove
-- sample data is then blocked again by a payment by ticket on a sample order) and the guard triggers are removed.
begin;
drop trigger if exists ticket_payment_applications_sample_cleanup on public.ticket_payment_applications;
drop function if exists private.ticket_payment_sample_cleanup();
drop trigger if exists ticket_payment_applications_delete_guard on public.ticket_payment_applications;
drop trigger if exists customer_payments_delete_guard on public.customer_payments;
alter table public.ticket_payment_applications
  drop constraint ticket_payment_applications_handoff_order_id_fkey,
  add constraint ticket_payment_applications_handoff_order_id_fkey foreign key (handoff_order_id) references public.billing_handoff_orders (id);
alter table public.customer_payments
  drop constraint customer_payments_company_id_customer_id_fkey,
  add constraint customer_payments_company_id_customer_id_fkey foreign key (company_id, customer_id) references public.customers (company_id, id);
alter table public.invoice_payments
  drop constraint invoice_payments_customer_payment_id_fkey,
  add constraint invoice_payments_customer_payment_id_fkey foreign key (customer_payment_id) references public.customer_payments (id);
commit;
