-- Rollback for 20261120005400_priority_customers.sql. Forgets which customers were priority.
begin;
drop function if exists public.demo_priority_customer();
drop function if exists public.set_customer_priority(uuid, boolean);
alter table public.customers drop column if exists is_priority;
commit;
