-- Rollback of 20261120001200_account_provisioning: restores the 20261120001100 company and portal gates and removes the
-- provisioning functions and tables. DESTRUCTIVE for setup state: the record of which sign-ins still need first-time
-- setup is dropped, so people with a pending temporary password would get normal access again with it. Before rolling
-- back, reissue or deactivate pending sign-ins (or accept that risk). Auth users, memberships, portal accounts and
-- audit events are kept. Run with psql -v ON_ERROR_STOP=1 -1 -f.
drop function if exists public.account_access_record(uuid, text, text);
drop function if exists public.account_employee_created(uuid);
drop function if exists public.portal_reactivate(uuid);
drop function if exists public.portal_create_login(uuid, uuid, uuid, text, text);
drop function if exists public.account_block_allowed(uuid, text);
drop function if exists public.account_events(uuid, text);
drop function if exists public.company_account_states(text);
drop function if exists public.account_setup_complete();
drop function if exists public.my_account_setup();
drop function if exists public.account_delivery_record(uuid, text, text, text, text);
drop function if exists public.account_setup_issue(uuid, text, integer, text);
drop function if exists public.account_setup_check(uuid, text);
drop function if exists public.account_provision_attach(uuid, uuid);
drop function if exists public.account_provision_begin(uuid, text, text);
drop function if exists public.account_username_available(text, text);

create or replace function private.current_company_id()
 returns uuid
 language sql
 stable
 security definer
 set search_path to ''
as $$
  -- One query, cheapest test first: this runs inside most row-level security policies. (Same membership choice as
  -- private.current_company_id_any(), inlined rather than called: a nested definer call costs ~15% on the Command Center.)
  select case
    when x.company_id is null then null
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

create or replace function private.portal_me(p_slug text)
 returns public.portal_accounts
 language plpgsql
 stable
 security definer
 set search_path to ''
as $$
declare
  v public.portal_accounts%rowtype;
  p private.portal_previews%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Not available.' using errcode = '42501';
  end if;
  select a.* into v
  from public.portal_accounts a join public.companies c on c.id = a.company_id
  where c.slug = p_slug and a.user_id = auth.uid() and a.status = 'active'
    and exists (select 1 from public.customers cu where cu.company_id = a.company_id and cu.id = a.customer_id and cu.active);
  if found and private.portal_open(v.company_id) then
    return v;
  end if;
  select pv.* into p from private.portal_previews pv join public.companies c on c.id = pv.company_id
  where pv.admin_id = auth.uid() and c.slug = p_slug and c.is_demo and pv.expires_at > now();
  if found and private.is_platform_admin() and (private.aal2() or not private.platform_mfa_enforced()) and private.portal_open(p.company_id)
     and exists (select 1 from public.customers cu where cu.company_id = p.company_id and cu.id = p.customer_id and cu.active) then
    select a.* into v from public.portal_accounts a
    where a.company_id = p.company_id and a.customer_id = p.customer_id and a.status = 'active' and a.user_id is null
      and lower(a.email) like 'preview-%@portal-preview.invalid'
    limit 1;
    if found then
      return v;
    end if;
  end if;
  raise exception 'Not available.' using errcode = '42501';
end;
$$;

drop function if exists private.setup_pending();
drop function if exists private.account_issue_allowed(uuid, text);
drop function if exists private.account_audit(uuid, text, uuid, text, jsonb);
drop function if exists private.provision_staff(text);
drop function if exists private.password_fingerprint(uuid);
drop function if exists private.username_address(text);
drop table if exists private.account_provisions;
drop table if exists private.account_setups;
