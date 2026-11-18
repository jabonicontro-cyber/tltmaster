-- Rollback of 20261120024610_truck_health_default_three: the default goes back to 2 unplanned repairs in 90 days, and
-- companies still on exactly the new default that no person changed (only the update itself, recorded without a
-- person, touched their rules) go back to the earlier default. A company that chose its own rules keeps them.
begin;
alter table public.company_settings
  alter column truck_health_rules
  set default '{"at_risk_repairs": 2, "watch_repairs": 1, "watch_open": 2, "service_overdue": "watch"}'::jsonb;

update public.company_settings s
   set truck_health_rules = jsonb_set(s.truck_health_rules, '{at_risk_repairs}', '2'::jsonb)
 where s.truck_health_rules = '{"at_risk_repairs": 3, "watch_repairs": 1, "watch_open": 2, "service_overdue": "watch"}'::jsonb
   and not exists (
     select 1 from public.audit_events e
      where e.company_id = s.company_id
        and e.entity_type = 'company_settings'
        and e.details ? 'truck_health_rules'
        and e.actor_id is not null);
commit;
