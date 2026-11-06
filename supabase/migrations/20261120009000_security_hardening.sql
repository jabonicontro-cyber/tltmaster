-- Security review 2026-11-06 (SEC2), fixes for findings in code already in production:
--   * L1: a customer's credit hold and credit limit change only with billing.manage, whichever way they are written
--     (the REST API allowed customers.edit to change them directly).
--   * M1 (part): accountant access is given only to a sign-in this company made for the accountant (or one that is already
--     this company's accountant), and never renames a person who belongs to another company.
--   * L3: reactivating a member lifts a sign-in block only when this company set it (account_unblock_allowed), never a
--     block the operator set.
--   * M3 (part): a per-sign-in limit on failed password attempts made through the app and the customer portal: after 8
--     failures in 15 minutes that sign-in is refused for 15 minutes. Stored as a hash of the login, never the login;
--     only the server (service role) can count or check. Supabase's own limits (set in its dashboard) stay in place.
-- Reversible: supabase/rollbacks/20261120009000_security_hardening.down.sql.

-- L1 --------------------------------------------------------------------------------------------------------------------
create or replace function private.customer_credit_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is not null
     and (new.credit_hold is distinct from old.credit_hold
          or new.credit_hold_reason is distinct from old.credit_hold_reason
          or new.credit_hold_at is distinct from old.credit_hold_at
          or new.credit_hold_by is distinct from old.credit_hold_by
          or new.credit_limit_cents is distinct from old.credit_limit_cents)
     and not private.has_permission('billing.manage') then
    raise exception 'Only billing can change a customer''s credit hold or credit limit.' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function private.customer_credit_guard() from public, anon, authenticated;
create trigger customer_credit_guard before update on public.customers
  for each row execute function private.customer_credit_guard();

-- M1 (part) -------------------------------------------------------------------------------------------------------------
create or replace function public.accountant_grant(p_user uuid, p_full_name text, p_ends_on date, p_payroll boolean)
returns void language plpgsql security definer set search_path = '' as $$
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
  -- Only a sign-in this company made (Settings, Accountant access) or this company's accountant already.
  if not found and not exists (select 1 from private.account_provisions a where a.company_id = v_company and a.user_id = p_user) then
    raise exception 'Sign-in not found.' using errcode = 'P0002';
  end if;
  if not exists (select 1 from public.profiles where id = p_user) then
    raise exception 'Sign-in not found.' using errcode = 'P0002';
  end if;
  -- The name is this company's to set only while the person belongs to no other company.
  if not exists (select 1 from public.company_memberships m where m.user_id = p_user and m.company_id <> v_company) then
    update public.profiles set full_name = coalesce(nullif(private.clean_text(p_full_name, 120, 'Name'), ''), full_name) where id = p_user;
  end if;
  insert into public.company_memberships (company_id, user_id, role, active, access_ends_at, payroll_view)
  values (v_company, p_user, 'accountant', true, private.end_of_company_day(v_company, p_ends_on), coalesce(p_payroll, false))
  on conflict (company_id, user_id) do update set active = true, access_ends_at = excluded.access_ends_at, payroll_view = excluded.payroll_view;
  perform private.log_event('accountant.granted', 'membership', p_user,
    format('Accountant access until %s%s', p_ends_on, case when p_payroll then ', with payroll' else '' end), jsonb_build_object('ends_on', p_ends_on, 'payroll', p_payroll));
end;
$$;

-- L3 --------------------------------------------------------------------------------------------------------------------
-- True only when this company's latest block/unblock record for the sign-in is a block (made by blockIfUnused).
create or replace function public.account_unblock_allowed(p_user uuid, p_kind text)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare
  v_company uuid := private.provision_staff(p_kind);
begin
  return coalesce((
    select e.action = 'account.sessions_blocked'
    from public.audit_events e
    where e.company_id = v_company and e.entity_type = 'account' and e.entity_id = p_user
      and e.action in ('account.sessions_blocked', 'account.sessions_unblocked')
    order by e.occurred_at desc, (e.action = 'account.sessions_unblocked') desc -- a tie counts as unblocked (the safe side)
    limit 1), false);
end;
$$;
revoke all on function public.account_unblock_allowed(uuid, text) from public, anon;
grant execute on function public.account_unblock_allowed(uuid, text) to authenticated;

-- M3 (part) -------------------------------------------------------------------------------------------------------------
create table private.signin_failures (
  login_hash text not null check (length(login_hash) = 64),
  at         timestamptz not null default now()
);
create index signin_failures_login on private.signin_failures (login_hash, at desc);
alter table private.signin_failures enable row level security;

-- Whether this sign-in may try now (fewer than 8 failures in the last 15 minutes). Old rows are ignored, never needed.
create or replace function public.signin_allowed(p_login_hash text)
returns boolean language sql stable security definer set search_path = '' as $$
  select (select count(*) from private.signin_failures f where f.login_hash = p_login_hash and f.at > now() - interval '15 minutes') < 8
$$;
revoke all on function public.signin_allowed(text) from public, anon, authenticated;
grant execute on function public.signin_allowed(text) to service_role;

create or replace function public.signin_failed(p_login_hash text)
returns void language sql security definer set search_path = '' as $$
  insert into private.signin_failures (login_hash) select p_login_hash where p_login_hash ~ '^[0-9a-f]{64}$';
$$;
revoke all on function public.signin_failed(text) from public, anon, authenticated;
grant execute on function public.signin_failed(text) to service_role;
