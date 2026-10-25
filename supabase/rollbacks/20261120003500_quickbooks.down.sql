-- Rollback of 20261120003500_quickbooks.sql (not a migration; run by hand with a backup first).
-- Removes the QuickBooks connections, their encrypted tokens, customer links and the send history. Invoices already
-- created in QuickBooks stay in QuickBooks. Disconnect in the app first so the tokens are revoked at Intuit.
begin;
drop function if exists public.accounting_finish_send(uuid, boolean, text, text, bigint, bigint, text);
drop function if exists public.accounting_begin_send(uuid, uuid, boolean);
drop function if exists public.accounting_link_customer(uuid, uuid, text, text, boolean);
drop function if exists public.accounting_disconnect(uuid);
drop function if exists public.accounting_set_item(uuid, text, text);
drop function if exists public.accounting_set_status(uuid, text);
drop function if exists public.accounting_save_connection(uuid, text, text, text);
drop function if exists private.accounting_connection(uuid);
drop table if exists public.accounting_invoice_sends;
drop table if exists public.accounting_customer_links;
drop table if exists public.accounting_connection_secrets;
drop table if exists public.accounting_connections;
commit;
