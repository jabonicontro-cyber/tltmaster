-- Rollback of 20261120000300_demo_plans (not a migration). Demo bases and record placement stay as they are.
drop function if exists public.platform_demo_set_plan(uuid, text);
