-- Rollback of 20261120003400_quickbooks.sql (not a migration; run by hand with a backup first).
-- Removes the QuickBooks connection, its encrypted tokens, customer links and the send history. Invoices already
-- created in QuickBooks stay in QuickBooks. Disconnect in the app first so the tokens are revoked at Intuit.
begin;
drop function if exists public.accounting_finish_send(uuid, boolean, text, text, bigint, bigint, text);
drop function if exists public.accounting_begin_send(uuid, boolean);
drop function if exists public.accounting_link_customer(uuid, text, text, boolean);
drop function if exists public.accounting_disconnect();
drop function if exists public.accounting_set_item(text, text);
drop function if exists public.accounting_set_status(text);
drop function if exists public.accounting_save_connection(text, text, text);
drop table if exists public.accounting_invoice_sends;
drop table if exists public.accounting_customer_links;
drop table if exists public.accounting_connection_secrets;
drop table if exists public.accounting_connections;
commit;
