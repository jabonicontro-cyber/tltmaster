-- Rollback of 20261120009400_ticket_payments: payments by delivery ticket removed. Invoice payments that came from a
-- ticket payment stay as ordinary invoice payments (the link column goes; the money record stays).
begin;
drop function if exists public.demo_ticket_payment_samples();
drop function if exists public.customer_payment_void(uuid, text);
drop function if exists public.customer_payment_apply(uuid, jsonb);
drop function if exists public.customer_payment_record(jsonb);
drop function if exists private.apply_customer_payment(uuid, jsonb);
drop function if exists public.customer_ticket_balances(uuid);
drop function if exists private.customer_payment_unapplied(uuid);
drop function if exists private.customer_ticket_rows(uuid, uuid);
drop function if exists private.handoff_issued_invoice(uuid);
drop trigger if exists invoice_payment_from_ticket_guard on public.invoice_payments;
drop function if exists private.invoice_payment_from_ticket_guard();
alter table public.invoice_payments drop column if exists customer_payment_id;
drop table if exists public.ticket_payment_applications;
drop table if exists public.customer_payments;
drop function if exists private.handoff_ticket_shares(jsonb);
drop function if exists private.split_cents(bigint, numeric[]);
commit;
