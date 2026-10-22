-- Rollback of 20261120001600_delivery_ticket_line_index.sql. Not destructive: removes an index only (no data).
-- Billing and Command Center queries keep working, slower. Run with psql -v ON_ERROR_STOP=1 -1 -f.

drop index if exists public.delivery_tickets_order_line_idx;
