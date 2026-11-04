-- Rollback for 20261120006900_portal_invoices.sql (functions only; no data is touched).
begin;
drop function if exists public.portal_invoice(text, uuid);
drop function if exists public.portal_invoices(text);
drop function if exists private.invoice_paid_cents(uuid);
drop function if exists private.portal_invoices_on(uuid);
commit;
