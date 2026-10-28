-- =============================================================================
-- Profit per load and per customer (B104, owner 2026-10-28).
--
-- Revenue is the verified delivered value already used by Reports (accepted current ticket quantity × the order
-- line's approved per-unit rate; 20261026000100). Cost comes only from the company's own rates, entered in Settings:
-- truck cost per hour, driver cost per hour and a fixed cost per load. Hours are the load's planned assignment
-- window (start to end on the dispatch board), so cost is an estimate and is labelled as one. Nothing is assumed: a
-- company without rates sees revenue and "no cost rates", a load without priced tickets or without hours is counted
-- and left out of the profit, never guessed.
--
--   company_cost_rates  one row per company: the three rates (null = not set), who set them and when.
--   set_cost_rates()    billing.manage; report_profit() billing.view, the company's own records only.
-- Reversible: supabase/rollbacks/20261120004400_load_profit.down.sql
-- =============================================================================

create table public.company_cost_rates (
  company_id             uuid primary key references public.companies (id),
  truck_hour_cents       integer check (truck_hour_cents between 0 and 1000000),
  driver_hour_cents      integer check (driver_hour_cents between 0 and 1000000),
  per_load_cents         integer check (per_load_cents between 0 and 10000000),
  updated_by             uuid references auth.users (id) on delete set null,
  updated_at             timestamptz not null default now()
);
alter table public.company_cost_rates enable row level security;
create policy company_cost_rates_read on public.company_cost_rates for select to authenticated
  using (company_id = (select private.current_company_id()) and (select private.has_permission('billing.view')));
revoke all on public.company_cost_rates from anon;
grant select on public.company_cost_rates to authenticated;

create or replace function public.set_cost_rates(p_truck_hour integer, p_driver_hour integer, p_per_load integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
begin
  perform private.require_permission('billing.manage');
  if coalesce(p_truck_hour, 0) < 0 or coalesce(p_driver_hour, 0) < 0 or coalesce(p_per_load, 0) < 0
     or coalesce(p_truck_hour, 0) > 1000000 or coalesce(p_driver_hour, 0) > 1000000 or coalesce(p_per_load, 0) > 10000000 then
    raise exception 'Enter rates between $0 and $10,000 per hour and up to $100,000 per load.' using errcode = '22023';
  end if;
  insert into public.company_cost_rates (company_id, truck_hour_cents, driver_hour_cents, per_load_cents, updated_by)
  values (v_company, p_truck_hour, p_driver_hour, p_per_load, auth.uid())
  on conflict (company_id) do update
    set truck_hour_cents = excluded.truck_hour_cents, driver_hour_cents = excluded.driver_hour_cents,
        per_load_cents = excluded.per_load_cents, updated_by = excluded.updated_by, updated_at = now();
  perform private.log_event('cost_rates.update', 'company', v_company, 'Cost rates changed',
    jsonb_build_object('truck_hour_cents', p_truck_hour, 'driver_hour_cents', p_driver_hour, 'per_load_cents', p_per_load));
end;
$$;

-- Profit for a period (delivery dates in the company's time zone), by load, then by customer and by truck.
create or replace function public.report_profit(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v_tz text;
  r public.company_cost_rates%rowtype;
  v_has_rates boolean;
  v_out jsonb;
begin
  perform private.require_permission('billing.view');
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then
    raise exception 'Choose a period of up to one year.' using errcode = '22023';
  end if;
  v_tz := private.business_timezone(v_company);
  select * into r from public.company_cost_rates where company_id = v_company;
  v_has_rates := found and (r.truck_hour_cents is not null or r.driver_hour_cents is not null or r.per_load_cents is not null);

  with tickets as (
    select t.assignment_id, t.order_id, t.truck_id,
           case when t.unit_code = l.unit_code and l.calc_method = 'per_unit' and l.unit_rate_cents > 0
                then round(t.quantity * l.unit_rate_cents)::bigint end as value_cents
      from public.delivery_tickets t
      left join public.order_lines l on l.id = t.order_line_id and l.company_id = v_company
     where t.company_id = v_company and t.status = 'accepted'
       and (t.delivered_at at time zone v_tz)::date between p_from and p_to
  ), loads as (
    select tk.assignment_id, min(tk.order_id::text)::uuid as order_id, min(tk.truck_id::text)::uuid as truck_id,
           sum(tk.value_cents) as revenue_cents, bool_or(tk.value_cents is null) as has_unpriced,
           round(extract(epoch from (a.ends_at - a.starts_at)) / 3600.0, 2) as hours
      from tickets tk
      left join public.dispatch_assignments a on a.id = tk.assignment_id and a.company_id = v_company
     group by tk.assignment_id, a.starts_at, a.ends_at
  ), costed as (
    select l.*, o.customer_id,
           case when v_has_rates and l.hours is not null and l.hours > 0
                then round(l.hours * (coalesce(r.truck_hour_cents, 0) + coalesce(r.driver_hour_cents, 0)) + coalesce(r.per_load_cents, 0))::bigint end as cost_cents
      from loads l
      left join public.orders o on o.id = l.order_id and o.company_id = v_company
  ), complete as (
    select * from costed where revenue_cents is not null and cost_cents is not null
  )
  select jsonb_build_object(
    'from', p_from, 'to', p_to, 'has_rates', v_has_rates,
    'rates', case when v_has_rates then jsonb_build_object('truck_hour_cents', r.truck_hour_cents, 'driver_hour_cents', r.driver_hour_cents, 'per_load_cents', r.per_load_cents) end,
    'loads', (select count(*) from costed),
    'loads_costed', (select count(*) from complete),
    'loads_without_price', (select count(*) from costed where revenue_cents is null),
    'loads_with_unpriced_tickets', (select count(*) from costed where has_unpriced and revenue_cents is not null),
    'loads_without_hours', (select count(*) from costed where hours is null or hours <= 0),
    'revenue_cents', (select coalesce(sum(revenue_cents), 0) from complete),
    'cost_cents', (select coalesce(sum(cost_cents), 0) from complete),
    'hours', (select coalesce(sum(hours), 0) from complete),
    'by_customer', coalesce((select jsonb_agg(x order by x.profit_cents desc) from (
        select coalesce(c.name, 'Unknown customer') as name, count(*) as loads, sum(k.revenue_cents) as revenue_cents, sum(k.cost_cents) as cost_cents,
               sum(k.revenue_cents) - sum(k.cost_cents) as profit_cents
          from complete k left join public.customers c on c.id = k.customer_id and c.company_id = v_company
         group by c.name order by sum(k.revenue_cents) - sum(k.cost_cents) desc limit 15) x), '[]'),
    'by_truck', coalesce((select jsonb_agg(x order by x.profit_cents desc) from (
        select coalesce(tr.unit_number, 'No truck') as name, count(*) as loads, sum(k.revenue_cents) as revenue_cents, sum(k.cost_cents) as cost_cents,
               sum(k.revenue_cents) - sum(k.cost_cents) as profit_cents, sum(k.hours) as hours
          from complete k left join public.trucks tr on tr.id = k.truck_id and tr.company_id = v_company
         group by tr.unit_number order by sum(k.revenue_cents) - sum(k.cost_cents) desc limit 15) x), '[]'))
  into v_out;
  return v_out;
end;
$$;

-- Demo samples: rates a small hauler might use, so the demo shows profit (demo owner only; once).
create or replace function public.demo_cost_rates()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_demo uuid := private.demo_owner_company();
begin
  if v_demo is null then
    raise exception 'Demo samples are only added to a demo company, by its owner.' using errcode = '42501';
  end if;
  if exists (select 1 from public.company_cost_rates where company_id = v_demo) then
    return 0;
  end if;
  insert into public.company_cost_rates (company_id, truck_hour_cents, driver_hour_cents, per_load_cents, updated_by)
  values (v_demo, 6500, 3200, 1500, auth.uid());
  return 1;
end;
$$;

revoke all on function public.set_cost_rates(integer, integer, integer), public.report_profit(date, date), public.demo_cost_rates() from public, anon;
grant execute on function public.set_cost_rates(integer, integer, integer), public.report_profit(date, date), public.demo_cost_rates() to authenticated;
