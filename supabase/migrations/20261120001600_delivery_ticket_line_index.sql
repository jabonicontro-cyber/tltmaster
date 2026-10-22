-- Index delivery tickets by order line.
--
-- The billing views (billing_load_status, billing_order_status) look up the live tickets of each order line. With no
-- index on order_line_id every lookup read all of the company's live tickets and discarded hundreds per row; for a
-- company with ~900 orders the Command Center exception list took 0.7-0.9 s per call (billing_order_status alone
-- 0.5 s), growing with the company's ticket history. Measured on the development database (2026-10-22): the exception
-- list drops from 735 ms to 250 ms and billing_order_status from 513 ms to 174 ms, with identical results.
--
-- Additive and data-free: no table, column, policy or function changes. Superseded revisions are excluded, as in
-- every lookup that uses it. Rollback: supabase/rollbacks/20261120001600_delivery_ticket_line_index.down.sql.

create index if not exists delivery_tickets_order_line_idx
  on public.delivery_tickets (order_line_id)
  where status <> 'superseded';

analyze public.delivery_tickets;
