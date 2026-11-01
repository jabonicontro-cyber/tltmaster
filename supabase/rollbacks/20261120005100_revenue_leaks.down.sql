-- Rollback for 20261120005100_revenue_leaks.sql (B110). Removes the "checked" marks; findings are computed, not stored.
begin;
drop function if exists public.revenue_leak_reopen(text);
drop function if exists public.revenue_leak_check(text, text, text);
drop function if exists public.revenue_leaks(integer, boolean);
drop table if exists public.revenue_leak_reviews;
commit;
