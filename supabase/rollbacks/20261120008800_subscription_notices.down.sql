-- Rollback of 20261120008800 (by hand, owner approval only). Lifecycle plans and prices already changed by applied tier
-- changes stay as they are; the notice history, grace periods and tier-change records are removed.
drop function if exists public.subscription_notice_mark(uuid, text, text);
drop function if exists public.subscription_pending_notices();
drop function if exists public.platform_tier_change_cancel(uuid, text);
drop function if exists public.platform_tier_change_schedule(uuid, uuid, date, integer);
drop function if exists public.platform_set_renewal(uuid, boolean);
drop function if exists public.platform_subscription_state(uuid);
drop function if exists public.platform_subscription_run();
drop function if exists public.subscription_run_cron();
drop function if exists private.subscription_run_core(date);
drop function if exists private.lowest_fitting_plan(integer, integer, date);
drop function if exists private.subscription_usage(uuid);
drop table if exists private.tier_changes;
drop table if exists private.subscription_grace;
drop table if exists private.subscription_events;
alter table private.company_lifecycle drop column if exists renewal_off;
