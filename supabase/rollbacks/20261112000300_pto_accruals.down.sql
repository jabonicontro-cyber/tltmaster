-- Rollback of 20261112000300_pto_accruals.sql (not a migration; run by hand with a backup first).
-- Removes accrual policies, hours worked and the accrual run. Ledger entries of kind 'accrual' and 'forfeiture' are
-- part of employees' balance history: this script refuses to run while any exist (export and decide first), so it
-- never silently changes a balance.
begin;
do $$
begin
  if exists (select 1 from public.pto_ledger where kind in ('accrual', 'forfeiture')) then
    raise exception 'Accrual or forfeiture entries exist in pto_ledger; export them and decide how to treat those balances before rolling back.';
  end if;
end $$;
drop function if exists public.pto_run_accruals(date);
drop function if exists private.pto_post_accrual(uuid, public.pto_policies, uuid, numeric, date, text, text);
drop function if exists public.pto_record_hours(jsonb);
drop function if exists public.pto_policy_end(uuid);
drop function if exists public.pto_policy_save(jsonb);
alter table public.pto_ledger drop constraint if exists pto_ledger_policy;
drop table if exists public.pto_hours_worked;
drop table if exists public.pto_policies;
drop index if exists public.pto_ledger_period;
alter table public.pto_ledger drop column if exists policy_id;
alter table public.pto_ledger drop column if exists period_key;
alter table public.pto_ledger drop constraint pto_ledger_sign;
alter table public.pto_ledger add constraint pto_ledger_sign
  check ((kind in ('grant', 'usage_reversal') and hours > 0) or (kind = 'usage' and hours < 0) or kind = 'adjustment');
alter table public.pto_ledger drop constraint pto_ledger_kind_check;
alter table public.pto_ledger add constraint pto_ledger_kind_check check (kind in ('grant', 'adjustment', 'usage', 'usage_reversal'));
commit;
