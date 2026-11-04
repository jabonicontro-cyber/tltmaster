-- Invoices and statements in the customer portal (UX5, owner 2026-11-04). Read-only: a customer sees their own issued
-- invoices (never drafts or voided ones), what was paid, the balance, and a statement with aging. Shown only when the
-- company issues its invoices in Taviron (invoicing_settings.issuer = 'taviron') and the portal's Documents switch is
-- on. Internal fields (price sources, quantity checks, billing-entity ids) are not returned. Functions only; no tables.
-- Reversible: supabase/rollbacks/20261120006900_portal_invoices.down.sql.

create or replace function private.portal_invoices_on(p_company uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.portal_feature(p_company, 'documents')
     and exists (select 1 from public.invoicing_settings s where s.company_id = p_company and s.issuer = 'taviron');
$$;
revoke all on function private.portal_invoices_on(uuid) from public, anon, authenticated;

-- What has been paid on an invoice (payments that are not voided).
create or replace function private.invoice_paid_cents(p_invoice uuid)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(amount_cents), 0)::bigint from public.invoice_payments where invoice_id = p_invoice and voided_at is null;
$$;
revoke all on function private.invoice_paid_cents(uuid) from public, anon, authenticated;

-- The customer's invoices and their statement: balance, overdue, and aging by days past due (as of the company's today).
create or replace function public.portal_invoices(p_slug text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v public.portal_accounts%rowtype := private.portal_me(p_slug);
  v_today date;
begin
  if not private.portal_invoices_on(v.company_id) then
    return jsonb_build_object('enabled', false);
  end if;
  v_today := private.business_today(v.company_id);
  return (
    with inv as (
      select i.*, private.invoice_paid_cents(i.id) as paid
        from public.invoices i
       where i.company_id = v.company_id and i.customer_id = v.customer_id and i.status = 'issued'
    ), rows as (
      select inv.*, greatest(inv.total_cents - inv.paid, 0) as balance, v_today - inv.due_date as days_late from inv
    )
    select jsonb_build_object(
      'enabled', true,
      'as_of', v_today,
      'invoices', coalesce((select jsonb_agg(jsonb_build_object(
          'id', r.id, 'number', r.number, 'issue_date', r.issue_date, 'due_date', r.due_date,
          'order_number', r.order_number, 'customer_po', r.customer_po, 'project_name', r.project_name,
          'total_cents', r.total_cents, 'paid_cents', r.paid, 'balance_cents', r.balance,
          'state', case when r.balance = 0 then 'paid' when r.days_late > 0 then 'overdue' else 'open' end)
          order by r.issue_date desc, r.number desc) from rows r), '[]'::jsonb),
      'statement', (select jsonb_build_object(
          'balance_cents', coalesce(sum(r.balance), 0),
          'overdue_cents', coalesce(sum(r.balance) filter (where r.days_late > 0), 0),
          'current_cents', coalesce(sum(r.balance) filter (where r.days_late <= 0), 0),
          'd1_30_cents', coalesce(sum(r.balance) filter (where r.days_late between 1 and 30), 0),
          'd31_60_cents', coalesce(sum(r.balance) filter (where r.days_late between 31 and 60), 0),
          'd61_90_cents', coalesce(sum(r.balance) filter (where r.days_late between 61 and 90), 0),
          'd90_plus_cents', coalesce(sum(r.balance) filter (where r.days_late > 90), 0),
          'open_count', count(*) filter (where r.balance > 0)) from rows r)));
end;
$$;

-- One of the customer's issued invoices: what it bills and what has been paid.
create or replace function public.portal_invoice(p_slug text, p_invoice uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v public.portal_accounts%rowtype := private.portal_me(p_slug);
  i public.invoices%rowtype;
  v_paid bigint;
begin
  if not private.portal_invoices_on(v.company_id) then
    raise exception 'This is not available in the portal.' using errcode = '42501';
  end if;
  select * into i from public.invoices where id = p_invoice and company_id = v.company_id and customer_id = v.customer_id and status = 'issued';
  if not found then
    raise exception 'Invoice not found.' using errcode = 'P0002';
  end if;
  v_paid := private.invoice_paid_cents(i.id);
  return jsonb_build_object(
    'id', i.id, 'number', i.number, 'issue_date', i.issue_date, 'due_date', i.due_date, 'terms_days', i.terms_days,
    'order_number', i.order_number, 'customer_po', i.customer_po, 'project_name', i.project_name,
    'service_start', i.service_start, 'service_end', i.service_end,
    'bill_to', i.bill_to, 'issued_by', i.issued_by_entity, 'footer', i.footer,
    'lines', (select coalesce(jsonb_agg(jsonb_build_object('description', l ->> 'description', 'quantity', l -> 'quantity',
                'unit_code', l ->> 'unit_code', 'unit_rate_cents', l -> 'unit_rate_cents', 'amount_cents', l -> 'amount_cents')
                order by (l ->> 'line_no')::int), '[]'::jsonb)
              from jsonb_array_elements(coalesce(i.lines, '[]'::jsonb)) l),
    'subtotal_cents', i.subtotal_cents, 'discount_cents', i.discount_cents, 'tax_cents', i.tax_cents, 'total_cents', i.total_cents,
    'payments', (select coalesce(jsonb_agg(jsonb_build_object('received_on', p.received_on, 'amount_cents', p.amount_cents, 'method', p.method) order by p.received_on), '[]'::jsonb)
                 from public.invoice_payments p where p.invoice_id = i.id and p.voided_at is null),
    'paid_cents', v_paid, 'balance_cents', greatest(i.total_cents - v_paid, 0));
end;
$$;

revoke all on function public.portal_invoices(text), public.portal_invoice(text, uuid) from public, anon;
grant execute on function public.portal_invoices(text), public.portal_invoice(text, uuid) to authenticated;
