-- =============================================================================
-- Payments by ticket and Settings → Sample data (fix for TP1, 20261120009400; found by the DB tests 2026-11-09).
--
-- "Remove sample data" deletes sample orders and customers (public.remove_sample_data). A payment by ticket on a sample
-- order blocked it ("violates foreign key constraint ticket_payment_applications_handoff_order_id_fkey"), as invoices
-- once did (fixed in 20261120005000). Same rule here: these are sample records too and go with their order or
-- customer, and only then. A payment of a real customer whose every ticket was a sample ticket is voided (kept on record,
-- "Sample data removed"), so it never shows as credit; a payment that also paid real tickets stays, with only the
-- sample part removed (shown as credit). Payments of sample customers go with the customer. Any other delete is refused: payments are
-- voided, never deleted. Reversible: supabase/rollbacks/20261120009700_ticket_payment_sample_removal.down.sql
-- =============================================================================

create trigger customer_payments_delete_guard before delete on public.customer_payments
  for each row execute function private.invoice_delete_guard();
create trigger ticket_payment_applications_delete_guard before delete on public.ticket_payment_applications
  for each row execute function private.invoice_delete_guard();

-- After a sample ticket's share is removed: a payment left with no ticket at all was a sample payment; void it.
create or replace function private.ticket_payment_sample_cleanup()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_setting('tlt.sample_purge', true) = 'on'
     and not exists (select 1 from public.ticket_payment_applications a where a.payment_id = old.payment_id) then
    update public.customer_payments p set voided_at = now(), void_reason = 'Sample data removed'
     where p.id = old.payment_id and p.company_id = old.company_id and p.voided_at is null;
  end if;
  return null;
end;
$$;
revoke all on function private.ticket_payment_sample_cleanup() from public, anon, authenticated;
create trigger ticket_payment_applications_sample_cleanup after delete on public.ticket_payment_applications
  for each row execute function private.ticket_payment_sample_cleanup();

alter table public.ticket_payment_applications
  drop constraint ticket_payment_applications_handoff_order_id_fkey,
  add constraint ticket_payment_applications_handoff_order_id_fkey foreign key (handoff_order_id) references public.billing_handoff_orders (id) on delete cascade;
alter table public.customer_payments
  drop constraint customer_payments_company_id_customer_id_fkey,
  add constraint customer_payments_company_id_customer_id_fkey foreign key (company_id, customer_id) references public.customers (company_id, id) on delete cascade;
alter table public.invoice_payments
  drop constraint invoice_payments_customer_payment_id_fkey,
  add constraint invoice_payments_customer_payment_id_fkey foreign key (customer_payment_id) references public.customer_payments (id) on delete set null;
