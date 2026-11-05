-- =============================================================================
-- Industry profile (owner 2026-11-05, master plan MK1): what a company hauls (aggregate and construction, general
-- freight, or both). It changes the words people see (delivery tickets or bills of lading), not the rules: one
-- application for every company. Existing companies stay 'aggregate', which is what they use today.
-- Changed like the other company settings: settings.manage, through the existing company_settings update policy.
-- Rollback: supabase/rollbacks/20261120007600_industry.down.sql
-- =============================================================================

alter table public.company_settings add column if not exists industry text not null default 'aggregate'
  check (industry in ('aggregate', 'freight', 'both'));
grant update (industry) on public.company_settings to authenticated;
