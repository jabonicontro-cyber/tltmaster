-- Read-only staging check (DEPLOYMENT §2a). Paste into Supabase → SQL Editor for the
-- STAGING project and run. It changes nothing: it reports which recent migrations the
-- database already has, and lead counts by status (no personal data).

-- 1. One row per recent migration: true = its objects are present.
select m.version, m.name, m.present
from (values
  ('20261023000100', 'site access gate',            to_regclass('private.site_access_grants') is not null),
  ('20261024000100', 'platform owner, leads, demo', to_regclass('private.platform_admins') is not null),
  ('20261025000100', 'order scheduling queue',      exists (select 1 from pg_proc where proname = 'operational_exceptions' and prosrc like '%order_unscheduled%')),
  ('20261026000100', 'operations report',           exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'report_operations')),
  ('20261027000100', 'Smart Dispatch, branding',    to_regclass('public.dispatch_recommendation_rejections') is not null),
  ('20261027000200', 'branding settings grant',     exists (select 1 from information_schema.column_privileges where table_schema = 'public' and table_name = 'company_settings' and column_name = 'brand_color' and grantee = 'authenticated' and privilege_type = 'UPDATE')),
  ('20261028000100', 'demo lead workflow',          to_regclass('private.lead_emails') is not null)
) as m(version, name, present)
order by m.version;

-- 2. What the Supabase CLI has recorded as applied (most recent first). Exists only on
--    Supabase; an error here locally is expected.
select version from supabase_migrations.schema_migrations order by version desc limit 10;
