-- =============================================================================
-- Simple mode (owner 2026-11-05, master plan SF1): the optional areas a company hides from its menu. Menu only:
-- permissions, rules and pages are unchanged, and safety areas are not in the list so they can never be hidden.
-- Existing companies hide nothing. Changed like the other company settings (settings.manage, existing policy).
-- Rollback: supabase/rollbacks/20261120007700_menu_areas.down.sql
-- =============================================================================

alter table public.company_settings add column if not exists hidden_areas text[] not null default '{}'
  check (hidden_areas <@ array['/quotes', '/support', '/customer-portal', '/maintenance', '/order-to-cash', '/payroll', '/schedule', '/time-off', '/reports']::text[]);
grant update (hidden_areas) on public.company_settings to authenticated;
