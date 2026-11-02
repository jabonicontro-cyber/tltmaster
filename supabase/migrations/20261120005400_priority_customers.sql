-- =============================================================================
-- Priority customers (owner 2026-11-02: "high priority customers … toggle this to ensure they get dispatched first").
-- A customer marked priority has their loads planned first by Smart Dispatch and Plan the day (right after urgent
-- orders), with a "Priority customer" badge. A preference for planning only: nothing is assigned automatically, and
-- safety, qualification and capacity rules still decide. customers.edit sets it; every change is in the audit log.
-- Reversible: supabase/rollbacks/20261120005400_priority_customers.down.sql
-- =============================================================================

alter table public.customers add column is_priority boolean not null default false;

create or replace function public.set_customer_priority(p_customer uuid, p_priority boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v_name text;
begin
  perform private.require_permission('customers.edit');
  update public.customers set is_priority = coalesce(p_priority, false)
   where id = p_customer and company_id = v_company
  returning name into v_name;
  if v_name is null then
    raise exception 'Customer not found.' using errcode = 'P0002';
  end if;
  perform private.log_event('customer.priority', 'customer', p_customer,
    format('%s %s a priority customer', v_name, case when p_priority then 'is now' else 'is no longer' end),
    jsonb_build_object('is_priority', p_priority));
end;
$$;

-- Demo sample: the demo's busiest customer is a priority customer, so the board shows the badge. Fictional.
create or replace function public.demo_priority_customer()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_demo uuid := private.demo_owner_company();
  v_id uuid;
begin
  if v_demo is null then
    raise exception 'Demo samples are only added to a demo company, by its owner.' using errcode = '42501';
  end if;
  if exists (select 1 from public.customers where company_id = v_demo and is_priority) then
    return 0;
  end if;
  select o.customer_id into v_id from public.orders o where o.company_id = v_demo and o.status not in ('draft', 'canceled')
   group by o.customer_id order by count(*) desc limit 1;
  if v_id is null then
    return 0;
  end if;
  update public.customers set is_priority = true where id = v_id and company_id = v_demo;
  return 1;
end;
$$;

revoke all on function public.set_customer_priority(uuid, boolean), public.demo_priority_customer() from public, anon;
grant execute on function public.set_customer_priority(uuid, boolean), public.demo_priority_customer() to authenticated;
