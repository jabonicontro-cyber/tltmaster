-- Rollback of 20261120024300_portal_company_industry.sql (not a migration; run by hand after a backup). Restores the
-- portal card without the industry field (as defined in 20261120000700_customer_portal.sql); the portal then uses its
-- general wording. No rows change.
begin;

create or replace function private.portal_company_card(p_company uuid)
 returns jsonb
 language sql
 stable
 security definer
 set search_path to ''
as $$
  select jsonb_build_object(
    'name', coalesce(nullif(s.display_name, ''), nullif(cs.company_name, ''), c.name),
    'slug', c.slug,
    'logo', coalesce(cs.brand_logo, ''),
    'color', coalesce(cs.brand_color, ''),
    'welcome', s.welcome,
    'contact_email', coalesce(nullif(s.contact_email, ''), cs.email, ''),
    'contact_phone', coalesce(nullif(s.contact_phone, ''), cs.phone, ''),
    'hours', s.hours,
    'timezone', coalesce(nullif(cs.timezone, ''), 'America/Chicago'),
    'is_demo', c.is_demo,
    'features', jsonb_build_object('orders', s.feature_orders, 'quotes', s.feature_quotes, 'documents', s.feature_documents,
                                   'support', s.feature_support, 'help', s.feature_help, 'tracking', s.feature_tracking))
  from public.companies c
  join public.portal_settings s on s.company_id = c.id
  left join public.company_settings cs on cs.company_id = c.id
  where c.id = p_company;
$$;
revoke all on function private.portal_company_card(uuid) from public, anon, authenticated;

commit;
