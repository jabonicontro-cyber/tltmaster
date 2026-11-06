-- Rollback for 20261120009000_security_hardening.sql (SEC2): restores accountant_grant as it was (20261120006300) and
-- removes the credit guard, the unblock check and the sign-in failure limit (its records are dropped).
CREATE OR REPLACE FUNCTION public.accountant_grant(p_user uuid, p_full_name text, p_ends_on date, p_payroll boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_company uuid := private.require_owner();
  v_today date := private.company_today(v_company);
  v_existing public.company_memberships;
begin
  if p_ends_on is null or p_ends_on < v_today or p_ends_on > v_today + 400 then
    raise exception 'Choose an end date from today up to about a year ahead.' using errcode = '22023';
  end if;
  select * into v_existing from public.company_memberships where company_id = v_company and user_id = p_user;
  if found and v_existing.role is distinct from 'accountant' then
    raise exception 'This person already works in the company; accountant access is for an outside accountant.' using errcode = '22023';
  end if;
  if not exists (select 1 from public.profiles where id = p_user) then
    raise exception 'Sign-in not found.' using errcode = 'P0002';
  end if;
  update public.profiles set full_name = coalesce(nullif(private.clean_text(p_full_name, 120, 'Name'), ''), full_name) where id = p_user;
  insert into public.company_memberships (company_id, user_id, role, active, access_ends_at, payroll_view)
  values (v_company, p_user, 'accountant', true, private.end_of_company_day(v_company, p_ends_on), coalesce(p_payroll, false))
  on conflict (company_id, user_id) do update set active = true, access_ends_at = excluded.access_ends_at, payroll_view = excluded.payroll_view;
  perform private.log_event('accountant.granted', 'membership', p_user,
    format('Accountant access until %s%s', p_ends_on, case when p_payroll then ', with payroll' else '' end), jsonb_build_object('ends_on', p_ends_on, 'payroll', p_payroll));
end;
$function$

;

drop trigger if exists customer_credit_guard on public.customers;
drop function if exists private.customer_credit_guard();
drop function if exists public.account_unblock_allowed(uuid, text);
drop function if exists public.signin_failed(text);
drop function if exists public.signin_allowed(text);
drop table if exists private.signin_failures;
