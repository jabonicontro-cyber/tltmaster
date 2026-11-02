-- Rollback for 20261120005700_hauler_settlements.sql. Forgets settlements, their jobs and deductions, and haulers'
-- commission rates (the audit log keeps its entries; nothing was ever paid by Taviron).
begin;
drop function if exists public.hauler_settlement_set_status(uuid, text, date, text, text);
drop function if exists public.hauler_settlement_remove_deduction(uuid);
drop function if exists public.hauler_settlement_deduct(uuid, text, bigint);
drop function if exists public.hauler_settlement_create(uuid, date, date);
drop function if exists public.hauler_set_commission(uuid, integer);
drop function if exists private.hauler_settlement_draft(uuid);
drop function if exists private.hauler_settlement_total(uuid);
drop table if exists public.hauler_settlement_deductions;
drop table if exists public.hauler_settlement_jobs;
drop table if exists public.hauler_settlements;
alter table public.haulers drop column if exists commission_bp;
commit;
