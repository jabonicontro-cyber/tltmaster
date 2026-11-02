-- B134 accountant view (owner 2026-11-02: "the owner sets an end date"; payroll "owner chooses per invite").
-- An outside accountant gets a sign-in with the role 'accountant' (20261120006200) that only reads financials:
--   * read-only by construction: the role may hold only accounting.view and billing.view (a trigger refuses anything
--     else, so the permission editor cannot widen it); every write function checks a manage permission it lacks;
--   * limited in time: the membership carries access_ends_at (end of the chosen day in the company's time zone).
--     After it, private.current_company_id() no longer returns the company, so every policy and function refuses;
--   * payroll only when the owner ticked it on the invite (payroll_view), read through accountant_* functions;
--   * only an owner invites, extends or ends an accountant; every change and every visit is in the audit log.
-- Non-destructive: columns, a permission, a trigger, functions; current_company_id gains the time limit.

alter table public.company_memberships
  add column access_ends_at timestamptz,
  add column payroll_view boolean not null default false;
alter table public.company_memberships
  add constraint company_memberships_accountant_ends check (role is distinct from 'accountant' or access_ends_at is not null),
  add constraint company_memberships_payroll_view check (not payroll_view or role = 'accountant');

insert into public.permissions (code, category, description) values
  ('accounting.view', 'Accounting', 'Open the accountant view: invoices, payments, receivables, profit, fuel and IFTA, hauler settlements, downloads')
on conflict (code) do nothing;
insert into public.role_permission_defaults (role, permission) values
  ('owner', 'accounting.view'), ('accountant', 'accounting.view'), ('accountant', 'billing.view')
on conflict do nothing;
insert into public.role_permissions (company_id, role, permission)
select c.id, d.role, d.permission from public.companies c cross join public.role_permission_defaults d
where d.role = 'accountant' or d.permission = 'accounting.view'
on conflict do nothing;

-- The accountant role is read-only: nothing but these two permissions, whoever edits the role.
create or replace function private.accountant_permissions_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.role = 'accountant' and new.permission not in ('accounting.view', 'billing.view') then
    raise exception 'The accountant role is read-only: it can hold only the accountant view and billing view.' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger role_permissions_accountant_guard before insert or update on public.role_permissions
  for each row execute function private.accountant_permissions_guard();

-- The time limit, in the same membership choice everywhere: an ended accountant membership is not a company.
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
    and (m.access_ends_at is null or m.access_ends_at > now())
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
  -- private.current_company_id_any(). No company below aal2 for enrolled/required two-step (20261120001100), none
  -- while first sign-in setup is pending (20261120001200), and none once a time-limited access ended (20261120006300).
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
      and (m.access_ends_at is null or m.access_ends_at > now())
    order by (m.company_id = p.active_company_id) desc nulls last, m.created_at, m.company_id
    limit 1) as company_id) x
$$;

-- Fuel and IFTA are read in the accountant view too.
create policy fuel_purchases_accounting_read on public.fuel_purchases for select to authenticated
  using (company_id = (select private.current_company_id()) and (select private.has_permission('accounting.view')));
create policy trip_sheets_accounting_read on public.trip_sheets for select to authenticated
  using (company_id = (select private.current_company_id()) and (select private.has_permission('accounting.view')));

-- Only an owner of the company (not merely users.manage) grants financial access.
create or replace function private.require_owner()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
begin
  if not exists (select 1 from public.company_memberships m where m.company_id = v_company and m.user_id = auth.uid() and m.active and m.role = 'owner') then
    raise exception 'Only an owner can give or change an accountant''s access.' using errcode = '42501';
  end if;
  return v_company;
end;
$$;
revoke all on function private.require_owner() from public, anon, authenticated;

-- End of a day in the company's time zone.
create or replace function private.end_of_company_day(p_company uuid, p_day date)
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $$
  select ((p_day + 1)::timestamp at time zone coalesce((select s.timezone from public.company_settings s where s.company_id = p_company), 'America/Chicago'));
$$;
revoke all on function private.end_of_company_day(uuid, date) from public, anon, authenticated;

-- Give a sign-in accountant access until the end of p_ends_on (at most 400 days ahead), payroll if p_payroll.
-- The sign-in itself is made by the account provisioning flow (src/server/accounts.ts) first.
create or replace function public.accountant_grant(p_user uuid, p_full_name text, p_ends_on date, p_payroll boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
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
$$;

-- Extend or shorten the end date, switch payroll, or end access now (p_end_now).
create or replace function public.accountant_set_access(p_user uuid, p_ends_on date, p_payroll boolean, p_end_now boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_owner();
  v_today date := private.company_today(v_company);
begin
  if not exists (select 1 from public.company_memberships where company_id = v_company and user_id = p_user and role = 'accountant') then
    raise exception 'Accountant not found.' using errcode = 'P0002';
  end if;
  if coalesce(p_end_now, false) then
    update public.company_memberships set access_ends_at = now() where company_id = v_company and user_id = p_user;
    perform private.log_event('accountant.ended', 'membership', p_user, 'Accountant access ended', '{}'::jsonb);
    return;
  end if;
  if p_ends_on is null or p_ends_on < v_today or p_ends_on > v_today + 400 then
    raise exception 'Choose an end date from today up to about a year ahead.' using errcode = '22023';
  end if;
  update public.company_memberships set access_ends_at = private.end_of_company_day(v_company, p_ends_on), payroll_view = coalesce(p_payroll, false), active = true
  where company_id = v_company and user_id = p_user;
  perform private.log_event('accountant.changed', 'membership', p_user,
    format('Accountant access until %s%s', p_ends_on, case when p_payroll then ', with payroll' else '' end), jsonb_build_object('ends_on', p_ends_on, 'payroll', p_payroll));
end;
$$;

-- The company's accountants for the owner's settings page (ended ones too).
create or replace function public.accountant_list()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('user_id', m.user_id, 'name', p.full_name, 'ends_at', m.access_ends_at,
           'payroll', m.payroll_view, 'current', m.active and m.access_ends_at > now(),
           'last_visit', (select max(e.occurred_at) from public.audit_events e where e.company_id = m.company_id and e.actor_id = m.user_id and e.action = 'accountant.visited'))
         order by m.access_ends_at desc), '[]'::jsonb)
  from public.company_memberships m join public.profiles p on p.id = m.user_id
  where m.company_id = private.require_owner() and m.role = 'accountant';
$$;

-- Each opening of the accountant view is recorded (who, when, which section).
create or replace function public.accountant_record_visit(p_section text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.require_permission('accounting.view');
  perform private.log_event('accountant.visited', 'accounting', auth.uid(), format('Opened the accountant view (%s)', left(coalesce(p_section, ''), 40)), '{}'::jsonb);
end;
$$;

-- What the signed-in person may see in the accountant view, and until when.
create or replace function public.accountant_me()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('role', m.role, 'ends_at', m.access_ends_at,
           'payroll', (m.role = 'owner') or (m.role = 'accountant' and m.payroll_view) or private.has_permission('payroll.manage'))
  from public.company_memberships m
  where m.company_id = private.current_company_id() and m.user_id = auth.uid() and private.has_permission('accounting.view');
$$;

-- Payroll for an accountant whose invite includes it (or payroll staff): approved periods and driver statements only.
create or replace function private.accountant_payroll_allowed(p_company uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.has_permission('payroll.manage')
      or exists (select 1 from public.company_memberships m where m.company_id = p_company and m.user_id = auth.uid()
                 and m.active and m.role = 'accountant' and m.payroll_view and m.access_ends_at > now());
$$;
revoke all on function private.accountant_payroll_allowed(uuid) from public, anon, authenticated;

create or replace function public.accountant_payroll_periods()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
begin
  if not private.accountant_payroll_allowed(v_company) then
    raise exception 'Payroll is not part of this access.' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', p.id, 'starts_on', p.starts_on, 'ends_on', p.ends_on, 'status', p.status,
             'drivers', (select coalesce(jsonb_agg(jsonb_build_object('driver_id', d.id, 'name', d.name,
                   'gross_cents', coalesce((select sum(e.amount_cents) from public.payroll_entries e where e.period_id = p.id and e.driver_id = d.id and e.status = 'calculated'), 0)
                                + coalesce((select sum(a.amount_cents) from public.payroll_adjustments a where a.period_id = p.id and a.driver_id = d.id), 0)) order by d.name), '[]'::jsonb)
                         from public.drivers d where d.company_id = v_company
                           and (exists (select 1 from public.payroll_entries e where e.period_id = p.id and e.driver_id = d.id and e.status = 'calculated')
                             or exists (select 1 from public.payroll_adjustments a where a.period_id = p.id and a.driver_id = d.id))))
           order by p.starts_on desc)
    from public.payroll_periods p
    where p.company_id = v_company and p.status in ('approved', 'exported', 'reconciled')), '[]'::jsonb);
end;
$$;

create or replace function public.accountant_pay_statement(p_period uuid, p_driver uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v jsonb;
begin
  if not private.accountant_payroll_allowed(v_company) then
    raise exception 'Payroll is not part of this access.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.payroll_periods where id = p_period and company_id = v_company and status in ('approved', 'exported', 'reconciled')) then
    raise exception 'Statement not found.' using errcode = 'P0002';
  end if;
  v := private.pay_statement(v_company, p_period, p_driver);
  if v is null then raise exception 'Statement not found.' using errcode = 'P0002'; end if;
  return v;
end;
$$;

revoke all on function public.accountant_grant(uuid, text, date, boolean) from public, anon;
revoke all on function public.accountant_set_access(uuid, date, boolean, boolean) from public, anon;
revoke all on function public.accountant_list() from public, anon;
revoke all on function public.accountant_record_visit(text) from public, anon;
revoke all on function public.accountant_me() from public, anon;
revoke all on function public.accountant_payroll_periods() from public, anon;
revoke all on function public.accountant_pay_statement(uuid, uuid) from public, anon;
grant execute on function public.accountant_grant(uuid, text, date, boolean) to authenticated;
grant execute on function public.accountant_set_access(uuid, date, boolean, boolean) to authenticated;
grant execute on function public.accountant_list() to authenticated;
grant execute on function public.accountant_record_visit(text) to authenticated;
grant execute on function public.accountant_me() to authenticated;
grant execute on function public.accountant_payroll_periods() to authenticated;
grant execute on function public.accountant_pay_statement(uuid, uuid) to authenticated;
