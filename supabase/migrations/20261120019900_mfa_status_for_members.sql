-- =============================================================================
-- Settings → Security shows who has set up two-step verification (owner 2026-11-12, "Yes, show it"; master plan §12
-- SEC4b).
--
--   * public.company_mfa_status(): for each active member of the caller's company (private.current_company_id() only,
--     through private.require_company()), whether they must use it because of money access in THIS company
--     ('money', the same rule as private.money_mfa_required() limited to this company, so nothing about another
--     company is revealed), whether a verified second factor exists ('set_up', the same test as
--     private.current_company_id()), and, only for those with money access, whether their recovery codes are saved and
--     confirmed ('recovery_ready', the same test as private.mfa_recovery_ready()). Nothing else: no factor ids, types,
--     names, secrets, codes, phone numbers or emails.
--   * Needs users.manage (the people list's own permission). Refused otherwise.
--   * Demo companies: money access never counts there (20261120018000), so 'money' is false for every member and the
--     page says "Not needed in a demo" (docs/DEMO_TENANTS.md §2).
--   * Taviron support visits: a visit acts with the owner's permissions (SA1, private.has_permission), so a visitor sees
--     what the company's owner sees here and nothing more (same as the other users.manage reads, for example
--     public.company_membership_invitations). The visitor is not a member, so their own state is never listed. Read only.
--
-- Additive: one new read-only function; no table, column or row changes.
-- Rollback: supabase/rollbacks/20261120019900_mfa_status_for_members.down.sql
-- =============================================================================

create or replace function public.company_mfa_status()
returns table (user_id uuid, money boolean, set_up boolean, recovery_ready boolean)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_company uuid := private.require_company();
  v_demo    boolean;
begin
  perform private.require_permission('users.manage');
  select c.is_demo into v_demo from public.companies c where c.id = v_company;
  return query
    with m as (
      select cm.user_id,
             (not coalesce(v_demo, false)
              and cm.role is not null
              and (cm.access_ends_at is null or cm.access_ends_at > now())
              and (cm.payroll_view
                   or exists (select 1 from public.role_permissions rp
                              where rp.company_id = v_company and rp.role = cm.role and private.is_money_permission(rp.permission)))) as money
      from public.company_memberships cm
      where cm.company_id = v_company and cm.active
    )
    select m.user_id,
           m.money,
           exists (select 1 from auth.mfa_factors f where f.user_id = m.user_id and f.status = 'verified'),
           case when m.money then
             exists (select 1 from private.mfa_recovery_codes r where r.user_id = m.user_id and r.used_at is null)
             and exists (select 1 from private.mfa_recovery_confirmations k
                         where k.user_id = m.user_id
                           and k.confirmed_at >= (select max(r.created_at) from private.mfa_recovery_codes r where r.user_id = m.user_id))
           end
    from m
    order by m.user_id;
end;
$$;
revoke all on function public.company_mfa_status() from public, anon;
grant execute on function public.company_mfa_status() to authenticated;
