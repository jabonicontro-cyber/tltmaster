-- N15 follow-up: company_settings is updated through column-level grants, so
-- the branding columns added in 20261027000100 need their own grant before the
-- Settings → Branding form can save them. Row-level security still limits the
-- update to the user's own company and to people with settings.manage.
grant update (brand_logo, brand_color, brand_sidebar_color) on public.company_settings to authenticated;
