-- Rollback for 20261120005300_empty_mile_cost.sql (B113). Removes the cost per empty mile.
begin;
drop function if exists public.demo_empty_mile_cost();
drop function if exists public.set_empty_mile_cost(integer);
alter table public.company_cost_rates drop column if exists empty_mile_cents;
commit;
