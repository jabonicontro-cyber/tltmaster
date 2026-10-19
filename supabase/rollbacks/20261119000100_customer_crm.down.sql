-- Rollback of 20261119000100_customer_crm (not a migration; run by hand with the owner's approval).
-- Refuses while CRM records exist, so no activity, task or opportunity is lost silently.
do $$
begin
  if to_regclass('public.customer_activities') is not null and (
       exists (select 1 from public.customer_activities) or exists (select 1 from public.customer_tasks)
       or exists (select 1 from public.crm_opportunities)) then
    raise exception 'CRM records exist; export them before rolling back 20261119000100.';
  end if;
end $$;

drop function if exists public.customer_duplicates(text, text, text);
drop function if exists public.customer_history(uuid);
drop trigger if exists orders_crm_customer on public.orders;
drop trigger if exists customers_crm_fields on public.customers;
drop table if exists public.customer_tasks;
drop table if exists public.crm_opportunity_events;
drop table if exists public.crm_opportunities;
drop table if exists public.customer_activities;
drop function if exists private.customer_task_rules();
drop function if exists private.crm_customer_on_order();
drop function if exists private.crm_opportunity_after();
drop function if exists private.crm_opportunity_rules();
drop function if exists private.guard_customer_crm_fields();
drop function if exists private.is_company_member(uuid, uuid);
alter table public.customers drop column if exists tags, drop column if exists account_owner_id, drop column if exists relationship;
