-- Rollback of 20261118000300_platform_lifecycle (not a migration; run by hand with the owner's approval).
-- Refuses while any company has a recorded lifecycle, a plan has a later version, or an acknowledgement exists, so no
-- subscription record is lost silently.
do $$
begin
  if exists (select 1 from private.company_lifecycle)
     or exists (select 1 from private.platform_plan_versions where version > 1)
     or exists (select 1 from private.platform_attention_acks) then
    raise exception 'Platform lifecycle data exists; export it before rolling back 20261118000300.';
  end if;
end $$;

drop function if exists public.platform_console();
drop function if exists public.platform_attention_ack(text, text);
drop function if exists public.platform_lifecycle_cancel(uuid, text, integer);
drop function if exists public.platform_lifecycle_go_live_now(uuid);
drop function if exists public.platform_lifecycle_go_live_on(uuid, date);
drop function if exists public.platform_lifecycle_fee(uuid, text, text);
drop function if exists public.platform_lifecycle_terms(uuid, jsonb);
drop function if exists public.platform_lifecycle(uuid);
drop function if exists public.platform_plan_version_create(jsonb);
drop function if exists public.platform_plans();
drop function if exists public.lifecycle_activate_due_cron();
drop function if exists private.lifecycle_activate_due();
drop function if exists private.lifecycle_for_update(uuid);
drop function if exists private.lifecycle_json(uuid);
drop function if exists private.commitment_months_left(date, date);
drop function if exists private.company_today(uuid);
drop table if exists private.platform_attention_acks;
drop table if exists private.company_lifecycle;
drop table if exists private.platform_plan_versions;
