-- Rollback for 20261120004400_load_profit.sql: the profit report, rate functions and the rates table.
drop function if exists public.demo_cost_rates();
drop function if exists public.report_profit(date, date);
drop function if exists public.set_cost_rates(integer, integer, integer);
drop table if exists public.company_cost_rates;
