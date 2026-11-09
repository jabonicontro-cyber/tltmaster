-- Rollback of 20261120012500_outside_repairs: removes vendor_warranties() and the vendor invoice and warranty columns
-- of work_order_costs (the recorded invoice numbers, dates and warranties are lost; the cost lines stay).
drop function if exists public.demo_outside_repair_samples();
drop function if exists public.vendor_warranties();
revoke insert (invoice_number, invoice_date, warranty_until) on public.work_order_costs from authenticated;
alter table public.work_order_costs drop constraint if exists work_order_costs_warranty_after_invoice;
alter table public.work_order_costs drop constraint if exists work_order_costs_vendor_fields;
alter table public.work_order_costs drop column if exists warranty_until;
alter table public.work_order_costs drop column if exists invoice_date;
alter table public.work_order_costs drop column if exists invoice_number;
