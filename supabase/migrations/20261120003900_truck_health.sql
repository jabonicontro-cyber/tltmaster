-- Truck health (master plan B93, owner 2026-10-27): each truck reads Good, Watch or At risk from simple rules the
-- company can adjust, and always shows why. The level is computed in the app from records the person can already see
-- (work orders, preventive service, service status); only the company's rules are stored here.
--
-- Mandatory, not adjustable: an open safety-critical defect, a restriction or Out of service is always At risk.
-- Adjustable (defaults):
--   at_risk_repairs  2   unplanned repairs in the last 90 days that make a truck At risk (0 = off)
--   watch_repairs    1   unplanned repairs in the last 90 days that make a truck Watch (0 = off)
--   watch_open       2   open non-safety work orders that make a truck Watch (0 = off)
--   service_overdue  'watch'   preventive service overdue: 'watch', 'at_risk' or 'off'
-- The level never blocks dispatch: safety restrictions already do, in the database.
--
-- Updated like other settings, through a column grant; RLS still requires settings.manage.
-- Reversible: supabase/rollbacks/20261120003900_truck_health.down.sql

alter table public.company_settings
  add column truck_health_rules jsonb not null
    default '{"at_risk_repairs": 2, "watch_repairs": 1, "watch_open": 2, "service_overdue": "watch"}'::jsonb
    constraint company_settings_truck_health_rules check (
      jsonb_typeof(truck_health_rules) = 'object'
      and (truck_health_rules ->> 'at_risk_repairs') ~ '^\d{1,2}$'
      and (truck_health_rules ->> 'watch_repairs') ~ '^\d{1,2}$'
      and (truck_health_rules ->> 'watch_open') ~ '^\d{1,2}$'
      and truck_health_rules ->> 'service_overdue' in ('watch', 'at_risk', 'off')
    );

grant update (truck_health_rules) on public.company_settings to authenticated;
