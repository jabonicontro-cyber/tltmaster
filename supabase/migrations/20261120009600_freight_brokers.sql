-- Freight brokers as customers (MK2, owner 2026-11-09: "broker bills, shipper on load"). A customer can be marked a
-- freight broker, with the broker's MC number. The broker is the customer who is invoiced; the shipper and receiver
-- are the stops on the load (20261120007800), and the broker's load number is kept in the order's customer reference
-- (customer_po), shown as "Load #" for brokers. Existing customers are unchanged (not brokers, no MC number).
alter table public.customers
  add column is_broker boolean not null default false,
  add column mc_number text not null default '' check (mc_number ~ '^[0-9]{0,8}$');
