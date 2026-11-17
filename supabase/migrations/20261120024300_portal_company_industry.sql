-- Customer portal in the company's own words (walkthrough 2026-11-14, W5): the portal card also says what the company
-- hauls (company_settings.industry: aggregate, freight or both), so a freight carrier's portal says "Bills of Lading"
-- and "Delivery locations" the way its workspace already does. The value is the same wording setting the company's
-- staff see; nothing else is added to the card and no access changes (portal_context and portal_public already return
-- this card to the same people). Additive and non-destructive: one field more in the card's JSON.
-- Reversible: supabase/rollbacks/20261120024300_portal_company_industry.down.sql.

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
    'industry', case when cs.industry in ('aggregate', 'freight', 'both') then cs.industry else 'aggregate' end,
    'features', jsonb_build_object('orders', s.feature_orders, 'quotes', s.feature_quotes, 'documents', s.feature_documents,
                                   'support', s.feature_support, 'help', s.feature_help, 'tracking', s.feature_tracking))
  from public.companies c
  join public.portal_settings s on s.company_id = c.id
  left join public.company_settings cs on cs.company_id = c.id
  where c.id = p_company;
$$;
revoke all on function private.portal_company_card(uuid) from public, anon, authenticated;
