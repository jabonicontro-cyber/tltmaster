-- =============================================================================
-- Outside (vendor) repairs: the vendor's invoice and warranty (2026-11-09).
--
-- An outside repair is already a cost line of kind 'vendor' on the work order (public.work_order_costs: description,
-- vendor_name, quantity, unit cost; maintenance.costs only). It now also records:
--   invoice_number   the vendor's invoice number
--   invoice_date     the vendor's invoice date
--   warranty_until   until when the vendor's repair is under warranty
-- Only on vendor lines (check), the warranty not before the invoice date. Written with the same insert grant and
-- policy as the other columns (maintenance.costs); locked like every cost line once the work order is closed.
-- public.vendor_warranties() lists the repairs still under warranty per truck or trailer for people who see
-- maintenance (no amounts), so a new defect on a unit can be checked against them.
-- public.demo_outside_repair_samples() (demo owner only, once): one outside repair with a fictional vendor invoice and
-- a warranty still running, on a completed demo work order.
-- Additive; works with the code before and after it.
-- Reversible: supabase/rollbacks/20261120012500_outside_repairs.down.sql
-- =============================================================================

alter table public.work_order_costs
  add column invoice_number text not null default '' check (length(invoice_number) <= 60),
  add column invoice_date date,
  add column warranty_until date;
alter table public.work_order_costs add constraint work_order_costs_vendor_fields check (
  kind = 'vendor' or (invoice_number = '' and invoice_date is null and warranty_until is null));
alter table public.work_order_costs add constraint work_order_costs_warranty_after_invoice check (
  warranty_until is null or invoice_date is null or warranty_until >= invoice_date);
grant insert (invoice_number, invoice_date, warranty_until) on public.work_order_costs to authenticated;

-- Repairs still under a vendor's warranty (maintenance.view): the unit, the work order, what, who and until when.
create or replace function public.vendor_warranties()
returns table (work_order_id uuid, work_order_number text, truck_id uuid, trailer_id uuid, description text,
  vendor_name text, invoice_number text, warranty_until date)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
begin
  perform private.require_permission('maintenance.view');
  return query
    select w.id, w.number, w.truck_id, w.trailer_id, c.description, c.vendor_name, c.invoice_number, c.warranty_until
    from public.work_order_costs c
    join public.work_orders w on w.id = c.work_order_id and w.company_id = c.company_id
    where c.company_id = v_company and c.kind = 'vendor' and c.warranty_until >= private.business_today(v_company)
      and w.status <> 'canceled'
    order by c.warranty_until;
end;
$$;
revoke all on function public.vendor_warranties() from public, anon;
grant execute on function public.vendor_warranties() to authenticated;

-- Demo: one outside repair on a completed work order, with a fictional vendor invoice and a 180-day warranty.
-- Demo owner only; once (found again by its invoice number).
create or replace function public.demo_outside_repair_samples()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_demo uuid := private.demo_owner_company();
  v_wo   public.work_orders%rowtype;
  v_today date;
begin
  if v_demo is null then
    raise exception 'Demo samples are only added to a demo company, by its owner.' using errcode = '42501';
  end if;
  if exists (select 1 from public.work_order_costs where company_id = v_demo and invoice_number = 'DEMO-INV-5521') then
    return 0;
  end if;
  select * into v_wo from public.work_orders where company_id = v_demo and status = 'completed' and truck_id is not null
  order by completed_at desc nulls last limit 1;
  if not found then
    return 0;
  end if;
  v_today := private.business_today(v_demo);
  insert into public.work_order_costs (company_id, work_order_id, kind, description, vendor_name, quantity, unit_cost_cents,
    invoice_number, invoice_date, warranty_until, created_by)
  values (v_demo, v_wo.id, 'vendor', 'Outside repair: radiator re-core (demo)', 'Fictional Radiator Shop (demo)', 1, 64500,
    'DEMO-INV-5521', v_today - 6, v_today + 174, auth.uid());
  return 1;
end;
$$;
revoke all on function public.demo_outside_repair_samples() from public, anon;
grant execute on function public.demo_outside_repair_samples() to authenticated;
