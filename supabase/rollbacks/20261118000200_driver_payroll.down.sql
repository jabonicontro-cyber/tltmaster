-- Rollback of 20261118000200_driver_payroll.sql. Refuses when payroll data exists (it would be lost); export it first.
do $$
begin
  if exists (select 1 from public.payroll_entries) or exists (select 1 from public.payroll_periods) or exists (select 1 from public.pay_rule_versions) then
    raise exception 'Payroll records exist. Export them and decide what to keep before rolling back.';
  end if;
end $$;
drop function if exists public.payroll_export_outcome(uuid, text, text, text);
drop function if exists public.payroll_export_record(uuid, text, text, integer, bigint);
drop function if exists public.payroll_period_approve(uuid);
drop function if exists public.payroll_adjust(uuid, uuid, bigint, text, uuid);
drop function if exists public.payroll_entry_set(uuid, text, text);
drop function if exists public.payroll_record_entries(uuid, jsonb);
drop function if exists public.payroll_period_work(uuid);
drop function if exists public.payroll_period_create(date, date);
drop function if exists public.payroll_rule_end(uuid, date);
drop function if exists public.payroll_rule_activate(uuid, text);
drop function if exists public.payroll_rule_draft(jsonb);
drop function if exists public.payroll_settings_save(jsonb);
drop function if exists private.payroll_open_period(uuid, uuid);
drop function if exists private.ticket_business_date(uuid, timestamptz);
drop function if exists private.payroll_company();
drop table if exists public.payroll_exports, public.payroll_adjustments, public.payroll_entries, public.payroll_periods,
  public.pay_rule_versions, public.pay_rules, public.payroll_settings;
delete from public.role_permissions where permission = 'payroll.manage';
delete from public.role_permission_defaults where permission = 'payroll.manage';
delete from public.permissions where code = 'payroll.manage';
