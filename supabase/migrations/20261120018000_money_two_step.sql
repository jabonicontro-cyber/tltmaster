-- =============================================================================
-- Two-step verification is always required for money access (owner decision 2026-11-09, master plan §12 SEC4).
--
--   * Who: anyone who holds a money permission (private.money_permissions()) through an active membership of an active,
--     real (non-demo) company. The company's own two-step setting cannot turn it off for them.
--   * Demo companies: a membership of a demo company never counts (fictional money). Someone who belongs only to demo
--     companies is exempt; someone who also holds money access in a real company is not, in every company.
--   * The database refuses too: below aal2 such a person gets no company (private.current_company_id()), exactly as for
--     a person who set up an authenticator or whose company requires it (20261120001100). The app sends them to /mfa.
--   * public.mfa_policy() reports it ('money') with the reason the /mfa page shows ('reason').
--   * Recovery codes are required for them (owner 2026-11-10): public.mfa_recovery_confirm() records that the person
--     saved the newest set; mfa_policy reports 'recovery_ready', and the app opens nothing until it is true.
--   * A visit is not a membership, so it never counts here. Instead a Taviron support visit into a real company now always
--     needs aal2 (private.support_company()), even with the database owner's emergency switch off (owner 2026-11-10).
--   * private.log_event() attributes an entry made below the second factor (a new owner's "company created") to the
--     person's membership company instead of leaving it without one.
--
-- Additive: one new private table (recovery confirmations); no existing table, column or row changes. Rollback: supabase/rollbacks/20261120018000_money_two_step.down.sql
-- =============================================================================

-- The permissions that show or change money (docs/TAVIRON_MASTER_PLAN.md §12 SEC4). One list, used by the policy below
-- and by tests; a new money permission is added here in a new migration.
create or replace function private.money_permissions()
returns text[] language sql immutable set search_path = '' as $$
  select array[
    'billing.view', 'billing.manage', 'accounting.view', 'payroll.manage', 'employees.compensation',
    'pricing.edit', 'pricing.override', 'maintenance.costs', 'audit.view',
    -- Company settings set the default sales tax rate; user management can hand any of these to any account.
    'settings.manage', 'users.manage'
  ]::text[]
$$;
revoke all on function private.money_permissions() from public, anon, authenticated;

-- Does the caller hold money access in any real company? (Active membership with a role, access not ended, active
-- non-demo company, a money permission for that role there, or an accountant's payroll access.)
create or replace function private.money_mfa_required()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.company_memberships m
    join public.companies c on c.id = m.company_id and c.active and not c.is_demo
    where m.user_id = auth.uid()
      and m.active
      and m.role is not null
      and (m.access_ends_at is null or m.access_ends_at > now())
      and (m.payroll_view
           or exists (select 1 from public.role_permissions rp
                      where rp.company_id = m.company_id and rp.role = m.role and rp.permission = any (private.money_permissions())))
  )
$$;
revoke all on function private.money_mfa_required() from public, anon, authenticated;

-- Latest definition: 20261120008900. Adds the money rule as the last test before the company is given.
create or replace function private.current_company_id()
returns uuid language sql stable security definer set search_path = '' as $$
  -- One query, cheapest test first (it runs inside most row-level security policies). Same membership choice as
  -- private.current_company_id_any(). No company below aal2 for enrolled/required two-step (20261120001100), none
  -- while first sign-in setup is pending (20261120001200), and none once a time-limited access ended (20261120006300).
  -- A Taviron support visit (20261120008900) takes precedence while it lasts. Money access in a real company always
  -- needs aal2 (20261120018000).
  select coalesce(private.support_company(), (
  select case
    when x.company_id is null then null
    when exists (select 1 from private.account_setups s where s.user_id = auth.uid() and s.status = 'setup_required') then null
    when coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2' then x.company_id
    when exists (select 1 from auth.mfa_factors f where f.user_id = auth.uid() and f.status = 'verified') then null
    when coalesce((select s.require_mfa from public.company_settings s where s.company_id = x.company_id), false) then null
    when private.money_mfa_required() then null
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
    limit 1) as company_id) x))
$$;

-- Latest definition: 20261011000200. An entry made below the second factor (no current company yet) is attributed to
-- the person's own membership company (same choice, without the two-step condition) instead of to no company.
create or replace function private.log_event(p_action text, p_entity_type text, p_entity_id uuid, p_summary text, p_details jsonb default '{}'::jsonb)
returns void language sql security definer set search_path = '' as $$
  insert into public.audit_events (company_id, actor_id, action, entity_type, entity_id, summary, details)
  values (coalesce(private.current_company_id(), private.current_company_id_any()), auth.uid(), p_action, p_entity_type, p_entity_id,
          coalesce(p_summary, ''), coalesce(p_details, '{}'::jsonb));
$$;

-- A Taviron support visit into a real company always needs a two-step verified session (owner decision 2026-11-10),
-- even while the database owner's emergency switch (platform_mfa_enforced = false) is off: during a visit staff hold the
-- owner's money permissions. The switch still lifts it for demo companies (fictional money). Latest definition:
-- 20261120008900.
create or replace function private.support_company()
returns uuid language sql stable security definer set search_path = '' as $$
  select s.company_id
  from private.support_sessions s
  join public.companies c on c.id = s.company_id and c.active
  join private.platform_admins a on a.user_id = s.user_id and a.revoked_at is null
  where s.user_id = auth.uid() and s.ended_at is null and s.ends_at > now()
    and (private.aal2() or (c.is_demo and not private.platform_mfa_enforced()))
    and (case when s.grant_id is null then not private.support_needs_grant(s.company_id)
              else exists (select 1 from public.support_access_grants g where g.id = s.grant_id and g.ended_at is null and g.ends_at > now()) end)
  order by s.started_at desc
  limit 1
$$;

-- Recovery codes are required for money access (owner decision 2026-11-10): setup is finished only once the person has
-- unused recovery codes and confirmed, after the newest set was created, that they saved them. New codes (My profile or
-- after a lost phone) need a new confirmation. The app refuses every page and action until then (src/server/mfa.ts);
-- the database records the confirmation and reports it in mfa_policy ('recovery_ready').
create table private.mfa_recovery_confirmations (
  user_id      uuid primary key references auth.users (id) on delete cascade,
  confirmed_at timestamptz not null default now()
);
revoke all on private.mfa_recovery_confirmations from public, anon, authenticated;

create or replace function private.mfa_recovery_ready()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from private.mfa_recovery_codes r where r.user_id = auth.uid() and r.used_at is null)
     and exists (select 1 from private.mfa_recovery_confirmations k
                 where k.user_id = auth.uid()
                   and k.confirmed_at >= (select max(r.created_at) from private.mfa_recovery_codes r where r.user_id = auth.uid()))
$$;
revoke all on function private.mfa_recovery_ready() from public, anon, authenticated;

-- "I saved these codes": only about the caller, only from a verified session, only when unused codes exist.
create or replace function public.mfa_recovery_confirm()
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or not private.aal2() then
    raise exception 'Verify with your authenticator app first.' using errcode = '42501';
  end if;
  if not exists (select 1 from private.mfa_recovery_codes r where r.user_id = auth.uid() and r.used_at is null) then
    raise exception 'Create recovery codes first.' using errcode = 'P0001';
  end if;
  insert into private.mfa_recovery_confirmations (user_id, confirmed_at) values (auth.uid(), now())
  on conflict (user_id) do update set confirmed_at = excluded.confirmed_at;
  perform private.security_log('mfa.recovery_confirmed', '{}'::jsonb);
end;
$$;
revoke all on function public.mfa_recovery_confirm() from public, anon;
grant execute on function public.mfa_recovery_confirm() to authenticated;

-- Latest definition: 20261120008900. Adds 'money', the reason shown to the person (most specific first) and
-- 'recovery_ready'.
create or replace function public.mfa_policy()
returns jsonb language sql stable security definer set search_path = '' as $$
  with p as (
    select private.is_platform_staff() and private.platform_mfa_enforced() as platform,
           private.money_mfa_required() as money,
           coalesce((select s.require_mfa from public.company_settings s where s.company_id = private.current_company_id_any()), false) as current_company
  )
  select jsonb_build_object(
    'platform', p.platform,
    'money', p.money,
    'companies', coalesce((select jsonb_agg(c.name order by c.name)
                           from public.company_memberships m
                           join public.companies c on c.id = m.company_id and c.active
                           join public.company_settings s on s.company_id = c.id
                           where m.user_id = auth.uid() and m.active and s.require_mfa), '[]'::jsonb),
    'current_company', p.current_company,
    'reason', case
      when p.platform then 'Platform administrators must use two-step verification.'
      when p.money then 'Your access to invoices, payments or pay requires two-step verification.'
      when p.current_company then 'Your company requires two-step verification.'
    end,
    'enrolled', private.mfa_enrolled(),
    'recovery_codes', (select count(*) from private.mfa_recovery_codes r where r.user_id = auth.uid() and r.used_at is null),
    'recovery_ready', private.mfa_recovery_ready(),
    'recent_failures', (select count(*) from private.mfa_attempts a where a.user_id = auth.uid() and not a.ok and a.at > now() - interval '15 minutes'),
    'aal2', private.aal2())
  from p
$$;
revoke all on function public.mfa_policy() from public, anon;
grant execute on function public.mfa_policy() to authenticated;
