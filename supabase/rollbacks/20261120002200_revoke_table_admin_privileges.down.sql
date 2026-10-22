-- Rollback of 20261120002200_revoke_table_admin_privileges.sql. Not destructive, but a SECURITY regression with no
-- reason to run it: it gives back exactly the TRUNCATE, TRIGGER and REFERENCES grants, and anon's table grants, that
-- existed before the migration (listed from a fresh database migrated through 20261120002100), and Supabase's default privileges for new
-- tables. Tables missing on a database are skipped. Run with psql -v ON_ERROR_STOP=1 -1 -f.

alter default privileges for role postgres in schema public grant truncate, trigger, references on tables to anon, authenticated;
alter default privileges for role postgres in schema public grant all on tables to anon;

do $$
declare
  g text;
begin
  foreach g in array array[
    'base_members|REFERENCES, TRIGGER, TRUNCATE|anon',
    'base_members|REFERENCES, TRIGGER, TRUNCATE|authenticated',
    'billing_exceptions|REFERENCES, TRIGGER, TRUNCATE|authenticated',
    'billing_line_status|REFERENCES, TRIGGER, TRUNCATE|authenticated',
    'billing_load_status|REFERENCES, TRIGGER, TRUNCATE|authenticated',
    'billing_order_status|REFERENCES, TRIGGER, TRUNCATE|authenticated',
    'crm_opportunities|REFERENCES, TRIGGER, TRUNCATE|anon',
    'crm_opportunities|REFERENCES, TRIGGER, TRUNCATE|authenticated',
    'crm_opportunity_events|REFERENCES, TRIGGER, TRUNCATE|anon',
    'crm_opportunity_events|REFERENCES, TRIGGER, TRUNCATE|authenticated',
    'customer_activities|REFERENCES, TRIGGER, TRUNCATE|anon',
    'customer_activities|REFERENCES, TRIGGER, TRUNCATE|authenticated',
    'customer_tasks|REFERENCES, TRIGGER, TRUNCATE|anon',
    'customer_tasks|REFERENCES, TRIGGER, TRUNCATE|authenticated',
    'dispatch_bases|REFERENCES, TRIGGER, TRUNCATE|anon',
    'dispatch_bases|REFERENCES, TRIGGER, TRUNCATE|authenticated',
    'dispatch_recommendation_rejections|REFERENCES, TRIGGER, TRUNCATE|anon',
    'dispatch_recommendation_rejections|REFERENCES, TRIGGER, TRUNCATE|authenticated',
    'employee_compensation|REFERENCES, TRIGGER, TRUNCATE|authenticated',
    'employee_work_schedules|REFERENCES, TRIGGER, TRUNCATE|authenticated',
    'employees|REFERENCES, TRIGGER|authenticated',
    'onboarding_form_versions|REFERENCES, TRIGGER, TRUNCATE|anon',
    'onboarding_form_versions|REFERENCES, TRIGGER, TRUNCATE|authenticated',
    'onboarding_forms|REFERENCES, TRIGGER, TRUNCATE|anon',
    'onboarding_forms|REFERENCES, TRIGGER, TRUNCATE|authenticated',
    'onboarding_signoffs|REFERENCES, TRIGGER, TRUNCATE|anon',
    'onboarding_signoffs|REFERENCES, TRIGGER, TRUNCATE|authenticated',
    'order_fulfillment|REFERENCES, TRIGGER, TRUNCATE|anon',
    'order_fulfillment|REFERENCES, TRIGGER, TRUNCATE|authenticated',
    'pay_rule_versions|REFERENCES, TRIGGER, TRUNCATE|authenticated',
    'pay_rules|REFERENCES, TRIGGER, TRUNCATE|authenticated',
    'payroll_adjustments|REFERENCES, TRIGGER, TRUNCATE|authenticated',
    'payroll_entries|REFERENCES, TRIGGER, TRUNCATE|authenticated',
    'payroll_exports|REFERENCES, TRIGGER, TRUNCATE|authenticated',
    'payroll_periods|REFERENCES, TRIGGER, TRUNCATE|authenticated',
    'payroll_settings|REFERENCES, TRIGGER, TRUNCATE|authenticated',
    'portal_accounts|REFERENCES, TRIGGER, TRUNCATE|anon',
    'portal_accounts|REFERENCES, TRIGGER, TRUNCATE|authenticated',
    'portal_help_articles|REFERENCES, TRIGGER, TRUNCATE|anon',
    'portal_help_articles|REFERENCES, TRIGGER, TRUNCATE|authenticated',
    'portal_help_feedback|REFERENCES, TRIGGER, TRUNCATE|anon',
    'portal_help_feedback|REFERENCES, TRIGGER, TRUNCATE|authenticated',
    'portal_messages|REFERENCES, TRIGGER, TRUNCATE|anon',
    'portal_messages|REFERENCES, TRIGGER, TRUNCATE|authenticated',
    'portal_quote_requests|REFERENCES, TRIGGER, TRUNCATE|anon',
    'portal_quote_requests|REFERENCES, TRIGGER, TRUNCATE|authenticated',
    'portal_quote_responses|REFERENCES, TRIGGER, TRUNCATE|anon',
    'portal_quote_responses|REFERENCES, TRIGGER, TRUNCATE|authenticated',
    'portal_settings|REFERENCES, TRIGGER, TRUNCATE|anon',
    'portal_settings|REFERENCES, TRIGGER, TRUNCATE|authenticated',
    'portal_support_requests|REFERENCES, TRIGGER, TRUNCATE|anon',
    'portal_support_requests|REFERENCES, TRIGGER, TRUNCATE|authenticated',
    'portal_tracking_links|REFERENCES, TRIGGER, TRUNCATE|anon',
    'portal_tracking_links|REFERENCES, TRIGGER, TRUNCATE|authenticated',
    'verified_delivery_inputs|REFERENCES, TRIGGER, TRUNCATE|authenticated',
    'base_members|DELETE, INSERT, SELECT, UPDATE|anon',
    'crm_opportunities|DELETE, INSERT, SELECT, UPDATE|anon',
    'crm_opportunity_events|DELETE, INSERT, SELECT, UPDATE|anon',
    'customer_activities|DELETE, INSERT, SELECT, UPDATE|anon',
    'customer_tasks|DELETE, INSERT, SELECT, UPDATE|anon',
    'dispatch_bases|DELETE, INSERT, SELECT, UPDATE|anon',
    'dispatch_recommendation_rejections|SELECT|anon',
    'onboarding_form_versions|DELETE, INSERT, SELECT, UPDATE|anon',
    'onboarding_forms|DELETE, INSERT, SELECT, UPDATE|anon',
    'onboarding_signoffs|DELETE, INSERT, SELECT, UPDATE|anon',
    'order_fulfillment|DELETE, INSERT, SELECT, UPDATE|anon',
    'portal_accounts|DELETE, INSERT, SELECT, UPDATE|anon',
    'portal_help_articles|DELETE, INSERT, SELECT, UPDATE|anon',
    'portal_help_feedback|DELETE, INSERT, SELECT, UPDATE|anon',
    'portal_messages|DELETE, INSERT, SELECT, UPDATE|anon',
    'portal_quote_requests|DELETE, INSERT, SELECT, UPDATE|anon',
    'portal_quote_responses|DELETE, INSERT, SELECT, UPDATE|anon',
    'portal_settings|DELETE, INSERT, SELECT, UPDATE|anon',
    'portal_support_requests|DELETE, INSERT, SELECT, UPDATE|anon',
    'portal_tracking_links|DELETE, INSERT, SELECT, UPDATE|anon'
  ] loop
    continue when to_regclass('public.' || split_part(g, '|', 1)) is null;
    execute format('grant %s on public.%I to %I', split_part(g, '|', 2), split_part(g, '|', 1), split_part(g, '|', 3));
  end loop;
end;
$$;
