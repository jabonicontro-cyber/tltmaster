-- Rollback of 20261120019000_quote_history_read.sql (not a migration; run by hand after a backup). Removes the read
-- policy that lets quotes.view read a quote's audit entries. Quote History then shows edits to audit.view (owners) only,
-- as before. No rows change.
begin;

drop policy if exists audit_read_quotes on public.audit_events;

commit;
