-- Rollback of 20261120007500_outreach.sql: removes outreach (prospects, suppressions, history, settings). Leads already
-- created from outreach stay in private.leads. Export the prospect and suppression lists first if they are needed.
drop function if exists public.outreach_unsubscribe(text);
drop function if exists public.platform_outreach_settings_save(jsonb);
drop function if exists public.platform_outreach_settings();
drop function if exists public.platform_outreach_convert(uuid);
drop function if exists public.platform_outreach_update(uuid, text, text);
drop function if exists public.platform_outreach_record(uuid, text);
drop function if exists public.platform_outreach_import(jsonb, text);
drop function if exists public.platform_outreach_get(uuid);
drop function if exists public.platform_outreach_list(text, text, text, text, integer, integer, integer, integer);
drop function if exists private.outreach_json(private.outreach_prospects);
drop function if exists private.outreach_int(jsonb, text);
drop function if exists private.outreach_text(jsonb, text, integer);
drop table if exists private.outreach_events;
drop table if exists private.outreach_settings;
drop table if exists private.outreach_suppressions;
drop table if exists private.outreach_prospects;
