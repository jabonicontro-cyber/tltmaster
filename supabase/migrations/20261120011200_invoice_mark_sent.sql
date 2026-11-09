-- Invoice "Mark as sent" by hand (owner 2026-11-09: a company that mails the invoice or emails it from its own inbox
-- records it as sent, without Taviron's email).
--
-- public.invoice_mark_sent(invoice, how) records that the person sent an issued invoice themselves: by mail, from their
-- own email, or handed over (billing.manage, issued invoices only). It sets sent_at with sent_via = 'manual' and how it
-- went, never sent_to (Taviron emailed nobody), and writes 'invoice.marked_sent' to the history, never 'invoice.sent'
-- ("emailed"). An invoice already recorded as sent is left as it is.
--
-- The delivery-proof guard (20261120009300, SEC2 L2) still requires the server's proof for every email send; it lets a
-- sent_at through without one only on this path: sent_via 'manual' together with a transaction-local mark that only
-- invoice_mark_sent sets (a person cannot set it through the API). invoice_record_sent now records sent_via 'email', so
-- an earlier manual mark can never carry an email send past the guard.
-- Reversible: supabase/rollbacks/20261120011200_invoice_mark_sent.down.sql

alter table public.invoices
  add column if not exists sent_via text check (sent_via in ('email', 'manual')),
  add column if not exists sent_how text not null default '' check (sent_how in ('', 'mail', 'own_email', 'handed_over')),
  add column if not exists sent_by uuid references auth.users (id) on delete set null;
alter table public.invoices drop constraint if exists invoices_sent_how_manual;
alter table public.invoices add constraint invoices_sent_how_manual check ((sent_via = 'manual') = (sent_how <> ''));

create or replace function private.invoice_sent_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Fires whenever a request sets sent_at (the trigger is on that column), even to the same time: each send needs its
  -- proof. The one exception is a person's own "I sent it myself" (invoice_mark_sent), which never claims an email.
  if new.sent_at is not null then
    if new.sent_via = 'manual' and new.sent_to = '{}'
       and coalesce(current_setting('taviron.invoice_manual_send', true), '') = new.id::text then
      return new;
    end if;
    perform private.require_delivery_proof(new.company_id, 'invoice.sent', new.id);
  end if;
  return new;
end;
$$;
revoke all on function private.invoice_sent_guard() from public, anon, authenticated;

-- An email send (or its preview): unchanged, except that a real send now says it was by email.
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
    update public.invoices set sent_at = now(), sent_to = coalesce(p_to, '{}'), sent_via = 'email', sent_how = '', sent_by = auth.uid()
     where id = v.id;
  end if;
  perform private.log_event(case when p_simulated then 'invoice.preview' else 'invoice.sent' end, 'invoice', v.id,
    format(case when p_simulated then 'Invoice %s email previewed (not sent) for %s' else 'Invoice %s emailed to %s' end,
           v.number, array_to_string(coalesce(p_to, '{}'), ', ')),
    jsonb_build_object('to', coalesce(p_to, '{}'), 'simulated', p_simulated));
end;
$$;

-- "I sent it myself": by mail, from my own email, or handed over. Returns true when recorded now, false when the
-- invoice was already recorded as sent (nothing changes).
create or replace function public.invoice_mark_sent(p_invoice uuid, p_how text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.invoices%rowtype := private.invoice_for_change(p_invoice);
begin
  if p_how is null or p_how not in ('mail', 'own_email', 'handed_over') then
    raise exception 'Choose how the invoice was sent: by mail, from your own email, or handed over.' using errcode = '22023';
  end if;
  if v.status <> 'issued' then
    raise exception 'Only an issued invoice can be marked as sent.' using errcode = '22023';
  end if;
  if v.sent_at is not null then
    return false;
  end if;
  perform set_config('taviron.invoice_manual_send', v.id::text, true);
  update public.invoices set sent_at = now(), sent_to = '{}', sent_via = 'manual', sent_how = p_how, sent_by = auth.uid()
   where id = v.id;
  perform set_config('taviron.invoice_manual_send', '', true);
  perform private.log_event('invoice.marked_sent', 'invoice', v.id,
    format('Invoice %s marked as sent by hand (%s); Taviron did not email it', v.number,
           case p_how when 'mail' then 'by mail' when 'own_email' then 'from their own email' else 'handed over' end),
    jsonb_build_object('how', p_how));
  return true;
end;
$$;
revoke all on function public.invoice_mark_sent(uuid, text) from public, anon;
grant execute on function public.invoice_mark_sent(uuid, text) to authenticated;
