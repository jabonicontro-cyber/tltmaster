-- Rollback of 20261120009300_verified_deliveries: sends are recorded on the caller's word again (finding L2 reopens).
begin;
drop trigger if exists invoice_sent_guard on public.invoices;
drop trigger if exists quote_email_sent_guard on public.email_deliveries;
drop trigger if exists accounting_sent_guard on public.accounting_invoice_sends;
drop function if exists private.invoice_sent_guard();
drop function if exists private.quote_email_sent_guard();
drop function if exists private.accounting_sent_guard();
drop function if exists private.require_delivery_proof(uuid, text, uuid);
drop function if exists public.delivery_proof_issue(uuid, text, uuid);
drop table if exists private.delivery_proofs;
commit;
