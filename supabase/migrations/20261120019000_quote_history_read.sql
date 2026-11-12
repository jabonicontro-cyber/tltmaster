-- Quote edits in the quote's History for everyone who can open the quote (owner walkthrough WK1, "quote edits not in
-- History").
--
-- Every quote change is already recorded in the audit log by the database functions that make it (save_quote_draft:
-- quote.created / quote.updated; revise_quote: quote.revised; issue, send and status changes). The quote page now
-- shows those entries in its History, read with the person's own session. Until now the audit log was readable only
-- with audit.view (owners) for quotes, so office staff who edit quotes saw only status changes.
--
-- This adds one read policy, like audit_read_orders and audit_read_fleet: the company's quote entries (entity_type
-- 'quote') with quotes.view. It shows nothing a quotes.view person cannot already see on the quote page (lines, totals,
-- price overrides, who it was sent to). Additive; no table, column, row or function changes. Without this update the
-- page still works and shows the edits to owners only.
--
-- Rollback: supabase/rollbacks/20261120019000_quote_history_read.down.sql (drops this policy only).

drop policy if exists audit_read_quotes on public.audit_events;
create policy audit_read_quotes on public.audit_events for select to authenticated
  using (company_id = (select private.current_company_id())
         and entity_type = 'quote'
         and (select private.has_permission('quotes.view')));
