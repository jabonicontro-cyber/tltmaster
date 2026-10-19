-- Rollback of 20261120000400_help_center (not a migration). Removes Help Center feedback, search log and requests.
drop function if exists public.platform_help_overview();
drop table if exists public.help_support_requests;
drop table if exists public.help_searches;
drop table if exists public.help_feedback;
