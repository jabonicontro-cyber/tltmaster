-- Rollback for 20261120005600_credit_holds.sql. Forgets credit holds, limits, the overdue rule and recorded overrides
-- (the audit log keeps its entries).
begin;
drop function if exists public.demo_credit_hold_sample();
drop function if exists public.record_credit_override(uuid, text, uuid, text);
drop function if exists public.credit_hold_save_settings(integer);
drop function if exists public.set_customer_credit_limit(uuid, bigint);
drop function if exists public.set_customer_credit_hold(uuid, boolean, text);
drop function if exists public.customer_credit_holds(uuid[]);
drop function if exists private.credit_holds(uuid, uuid[]);
drop table if exists public.credit_hold_overrides;
drop table if exists public.credit_hold_settings;
alter table public.customers
  drop column if exists credit_limit_cents,
  drop column if exists credit_hold_by,
  drop column if exists credit_hold_at,
  drop column if exists credit_hold_reason,
  drop column if exists credit_hold;
commit;
