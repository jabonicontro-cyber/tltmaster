-- Rollback of 20261120011200_invoice_mark_sent: "Mark as sent" by hand removed; the delivery-proof guard and
-- invoice_record_sent return to their 20261120009300 / 20261120004800 definitions. Invoices already marked as sent by
-- hand keep their sent time (they show as sent, with no addresses); how they were sent is dropped with the columns.
begin;
drop function if exists public.invoice_mark_sent(uuid, text);

create or replace function private.invoice_sent_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Fires whenever a request sets sent_at (the trigger is on that column), even to the same time: each send needs its proof.
  if new.sent_at is not null then
    perform private.require_delivery_proof(new.company_id, 'invoice.sent', new.id);
  end if;
  return new;
end;
$$;
revoke all on function private.invoice_sent_guard() from public, anon, authenticated;

create or replace function public.invoice_record_sent(p_invoice uuid, p_to text[], p_simulated boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.invoices%rowtype := private.invoice_for_change(p_invoice);
begin
  if v.status <> 'issued' then
    raise exception 'Only an issued invoice can be sent.' using errcode = '22023';
  end if;
  if not p_simulated then
    update public.invoices set sent_at = now(), sent_to = coalesce(p_to, '{}') where id = v.id;
  end if;
  perform private.log_event(case when p_simulated then 'invoice.preview' else 'invoice.sent' end, 'invoice', v.id,
    format(case when p_simulated then 'Invoice %s email previewed (not sent) for %s' else 'Invoice %s emailed to %s' end,
           v.number, array_to_string(coalesce(p_to, '{}'), ', ')),
    jsonb_build_object('to', coalesce(p_to, '{}'), 'simulated', p_simulated));
end;
$$;

alter table public.invoices drop constraint if exists invoices_sent_how_manual;
alter table public.invoices drop column if exists sent_by, drop column if exists sent_how, drop column if exists sent_via;
commit;
