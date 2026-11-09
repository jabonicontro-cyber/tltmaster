-- =============================================================================
-- Demo credit-hold sample: never the customer whose loads the planning day is about.
--
-- public.demo_credit_hold_sample (20261120005600) puts one demo customer on a manual credit hold so orders and the board
-- show the warning. It picked the customer with the fewest open orders, ties broken by customer id. In the presenter
-- demo three customers tie with one order each when the sample runs, one of them the customer of tomorrow's planned
-- (unassigned) loads, so about one demo in three put every load of the planning day on hold: "Plan the day" then had
-- nothing to plan and only listed the held loads (found by tests/e2e/plan-the-day.spec.ts, 2026-11-09).
--
-- Now a customer with planned loads after today (the company's business date) is chosen only when no other customer
-- qualifies; otherwise the rule is unchanged (fewest open orders, not the priority customer, then customer id). Demo
-- companies only, by their owner, as before; a demo that already has a customer on hold is left as it is.
--
-- Reversible: supabase/rollbacks/20261120014200_demo_credit_hold_pick.down.sql restores the earlier definition.
-- =============================================================================

create or replace function public.demo_credit_hold_sample()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_demo uuid := private.demo_owner_company();
  v_today date;
  v_id uuid;
begin
  if v_demo is null then
    raise exception 'Demo samples are only added to a demo company, by its owner.' using errcode = '42501';
  end if;
  if exists (select 1 from public.customers where company_id = v_demo and credit_hold) then
    return 0;
  end if;
  v_today := private.business_today(v_demo);
  -- A customer with orders but not the priority one, so the two badges are shown on different customers; one whose
  -- loads are still to be planned after today last, so the planning day keeps work to plan.
  select x.customer_id into v_id
  from (
    select o.customer_id, count(*) as n
    from public.orders o join public.customers c on c.id = o.customer_id
    where o.company_id = v_demo and o.status not in ('draft', 'canceled') and c.active and not coalesce(c.is_priority, false)
    group by o.customer_id
  ) x
  order by exists (
             select 1 from public.order_loads l join public.orders o on o.id = l.order_id and o.company_id = l.company_id
             where l.company_id = v_demo and o.customer_id = x.customer_id and o.status not in ('draft', 'canceled')
               and l.status = 'planned' and l.load_date > v_today
           ),
           x.n, x.customer_id
  limit 1;
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
