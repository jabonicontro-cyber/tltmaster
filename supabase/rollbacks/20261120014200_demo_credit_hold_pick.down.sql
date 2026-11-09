-- Rollback of 20261120014200_demo_credit_hold_pick.sql (not a migration; run by hand with a backup first).
-- Restores public.demo_credit_hold_sample exactly as 20261120005600 defined it. A hold already set stays (demo data).
begin;
create or replace function public.demo_credit_hold_sample()
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
  if exists (select 1 from public.customers where company_id = v_demo and credit_hold) then
    return 0;
  end if;
  -- A customer with orders but not the priority one, so the two badges are shown on different customers.
  select o.customer_id into v_id from public.orders o join public.customers c on c.id = o.customer_id
  where o.company_id = v_demo and o.status not in ('draft', 'canceled') and c.active and not coalesce(c.is_priority, false)
  group by o.customer_id order by count(*) asc, o.customer_id limit 1;
  if v_id is null then
    return 0;
  end if;
  update public.customers set credit_hold = true, credit_hold_reason = 'Two invoices more than 60 days late (demo).', credit_hold_at = now(), credit_hold_by = auth.uid()
  where id = v_id and company_id = v_demo;
  return 1;
end;
$$;

revoke all on function public.demo_credit_hold_sample() from public, anon;
grant execute on function public.demo_credit_hold_sample() to authenticated;
commit;
