-- =============================================================================
-- Truck health: "At risk" from 3 unplanned repairs in 90 days by default (owner decision 2026-11-16/17, WK3).
--
-- The first-day walkthrough found the red "At risk" line on 9 of 10 trucks, so it lost its meaning. The owner chose:
--   * the default number of unplanned repairs in the last 90 days that makes a truck At risk goes from 2 to 3;
--   * Watch stays at 1 repair; open repairs and overdue service are unchanged;
--   * an open safety-critical defect, a restriction or Out of service stays At risk whatever the rules say (that is in
--     the app's rule, src/lib/fleet/health.ts, and cannot be adjusted);
--   * a company that already set its own rules keeps them.
--
-- How "never set" is known: the rules column (20261120003900) has a default, so every company has a value. A company
-- that changed its rules in Settings has an audit entry for that change (company_settings is audited row by row,
-- private.audit_row_change, details keyed by column). Only companies whose rules are still exactly the old default and
-- that never had a truck_health_rules change recorded get the new number; every other company is left as it is.
-- The new default applies to companies created from now on.
-- Data change: one value in company settings (recorded by the same audit trigger). No functions, no permissions.
-- Reversible: supabase/rollbacks/20261120024610_truck_health_default_three.down.sql
-- =============================================================================

alter table public.company_settings
  alter column truck_health_rules
  set default '{"at_risk_repairs": 3, "watch_repairs": 1, "watch_open": 2, "service_overdue": "watch"}'::jsonb;

update public.company_settings s
   set truck_health_rules = jsonb_set(s.truck_health_rules, '{at_risk_repairs}', '3'::jsonb)
 where s.truck_health_rules = '{"at_risk_repairs": 2, "watch_repairs": 1, "watch_open": 2, "service_overdue": "watch"}'::jsonb
   and not exists (
     select 1 from public.audit_events e
      where e.company_id = s.company_id
        and e.entity_type = 'company_settings'
        and e.details ? 'truck_health_rules');
