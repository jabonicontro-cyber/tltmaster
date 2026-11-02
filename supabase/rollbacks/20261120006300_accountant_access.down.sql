-- Rollback for 20261120006300_accountant_access.sql. Accountant memberships are switched off (kept for the audit
-- trail), the accountant functions, policies, trigger and permission are removed, and current_company_id is restored
-- to its form before the time limit (20261120001200).
begin;
update public.company_memberships set active = false where role = 'accountant';
drop function if exists public.accountant_pay_statement(uuid, uuid);
drop function if exists public.accountant_payroll_periods();
drop function if exists private.accountant_payroll_allowed(uuid);
drop function if exists public.accountant_me();
drop function if exists public.accountant_record_visit(text);
drop function if exists public.accountant_list();
drop function if exists public.accountant_set_access(uuid, date, boolean, boolean);
drop function if exists public.accountant_grant(uuid, text, date, boolean);
drop function if exists private.end_of_company_day(uuid, date);
drop function if exists private.require_owner();
drop policy if exists fuel_purchases_accounting_read on public.fuel_purchases;
drop policy if exists trip_sheets_accounting_read on public.trip_sheets;
drop trigger if exists role_permissions_accountant_guard on public.role_permissions;
drop function if exists private.accountant_permissions_guard();
create or replace function private.current_company_id_any()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.company_id
  from public.company_memberships m
  join public.companies c on c.id = m.company_id and c.active
  join public.profiles p on p.id = m.user_id
  where m.user_id = auth.uid()
    and m.active
    and m.role is not null
  order by (m.company_id = p.active_company_id) desc nulls last, m.created_at, m.company_id
  limit 1
$$;

create or replace function private.current_company_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  -- One query, cheapest test first (it runs inside most row-level security policies). Same membership choice as
  -- private.current_company_id_any(). No company below aal2 for enrolled/required two-step (20261120001100), and none
  -- while first sign-in setup is pending (20261120001200).
  select case
    when x.company_id is null then null
    when exists (select 1 from private.account_setups s where s.user_id = auth.uid() and s.status = 'setup_required') then null
    when coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2' then x.company_id
    when exists (select 1 from auth.mfa_factors f where f.user_id = auth.uid() and f.status = 'verified') then null
    when coalesce((select s.require_mfa from public.company_settings s where s.company_id = x.company_id), false) then null
    else x.company_id
  end
  from (select (
    select m.company_id
    from public.company_memberships m
    join public.companies c on c.id = m.company_id and c.active
    join public.profiles p on p.id = m.user_id
    where m.user_id = auth.uid()
      and m.active
      and m.role is not null
      order by (m.company_id = p.active_company_id) desc nulls last, m.created_at, m.company_id
    limit 1) as company_id) x
$$;

delete from public.role_permissions where role = 'accountant' or permission = 'accounting.view';
delete from public.role_permission_defaults where role = 'accountant' or permission = 'accounting.view';
delete from public.permissions where code = 'accounting.view';
alter table public.company_memberships drop constraint if exists company_memberships_payroll_view;
alter table public.company_memberships drop constraint if exists company_memberships_accountant_ends;
alter table public.company_memberships drop column if exists payroll_view;
alter table public.company_memberships drop column if exists access_ends_at;
commit;
