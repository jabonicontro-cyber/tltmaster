-- =============================================================================
-- Invoices and Settings → Sample data (fix for B99, 20261120004800).
--
-- "Remove sample data" deletes sample orders (public.remove_sample_data). An invoice on such an order blocked it
-- ("violates foreign key constraint invoices_company_id_order_id_fkey"), so a company that invoiced a sample order
-- could no longer remove its sample data. Invoices of sample orders are sample records too: they now go with their
-- order, and only then. Any other attempt to delete an invoice or a payment is refused (they are voided, never
-- deleted), so the cascade cannot remove real billing records.
-- Reversible: supabase/rollbacks/20261120005000_invoice_sample_removal.down.sql
-- =============================================================================

create or replace function private.invoice_delete_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- tlt.sample_purge is set only inside public.remove_sample_data() (20261010000400_sample_data.sql).
  if current_setting('tlt.sample_purge', true) is distinct from 'on' then
    raise exception 'Invoices and payments are voided, never deleted.' using errcode = '42501';
  end if;
  return old;
end;
$$;

create trigger invoices_delete_guard before delete on public.invoices
  for each row execute function private.invoice_delete_guard();
create trigger invoice_payments_delete_guard before delete on public.invoice_payments
  for each row execute function private.invoice_delete_guard();

alter table public.invoices
  drop constraint invoices_company_id_order_id_fkey,
  add constraint invoices_company_id_order_id_fkey foreign key (company_id, order_id) references public.orders (company_id, id) on delete cascade,
  drop constraint invoices_handoff_order_id_fkey,
  add constraint invoices_handoff_order_id_fkey foreign key (handoff_order_id) references public.billing_handoff_orders (id) on delete cascade;
alter table public.invoice_payments
  drop constraint invoice_payments_company_id_invoice_id_fkey,
  add constraint invoice_payments_company_id_invoice_id_fkey foreign key (company_id, invoice_id) references public.invoices (company_id, id) on delete cascade;
