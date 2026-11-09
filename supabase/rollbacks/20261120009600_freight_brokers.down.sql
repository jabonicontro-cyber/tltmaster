-- Rollback of 20261120009600_freight_brokers: the broker mark and MC numbers are removed from customers.
begin;
alter table public.customers drop column if exists mc_number, drop column if exists is_broker;
commit;
