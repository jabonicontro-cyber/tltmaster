-- Verified deliveries (security audit 2026-11-06, finding L2).
--
-- Recording that an invoice was emailed, a quote was emailed, or an invoice was created in QuickBooks used to rest on the
-- caller's word: a person with billing.manage or quotes.send could call the recording functions over the API and mark
-- something delivered that never left. Now a signed-in person's request records such a success only with a proof that
-- the server issued after the email or accounting service answered:
--   * public.delivery_proof_issue: executable by the server's service role only; returns a one-time proof for one
--     company, one kind and one record.
--   * The server sends the proof with the person's own request (header x-taviron-delivery-proof); the recording
--     functions keep running as that person, with their permission checks and history names.
--   * Triggers on the three records refuse the success without a matching, unused proof issued in the last 10 minutes,
--     and use it up. Previews, failures, simulated demo sends and a person's own "mark as sent" (manual channel) need
--     none: they never claim that Taviron delivered anything.
-- The server's own account, migrations and seeds write without a proof (no signed-in person behind them).

create table private.delivery_proofs (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies (id) on delete cascade,
  kind        text not null check (kind in ('invoice.sent', 'quote.sent', 'accounting.sent')),
  target_id   uuid not null,
  created_at  timestamptz not null default now(),
  used_at     timestamptz
);
alter table private.delivery_proofs enable row level security;
revoke all on private.delivery_proofs from public, anon, authenticated;
create index delivery_proofs_open on private.delivery_proofs (target_id, kind) where used_at is null;

-- Server only (service role): issued after the provider confirmed the delivery.
create or replace function public.delivery_proof_issue(p_company uuid, p_kind text, p_target uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_company is null or p_target is null then
    raise exception 'A company and a record are required.' using errcode = '22023';
  end if;
  -- Proofs older than a day are of no use; keep the table small.
  update private.delivery_proofs set used_at = coalesce(used_at, now()) where created_at < now() - interval '1 day' and used_at is null;
  insert into private.delivery_proofs (company_id, kind, target_id) values (p_company, p_kind, p_target) returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.delivery_proof_issue(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.delivery_proof_issue(uuid, text, uuid) to service_role;

-- Used by the triggers below: a signed-in person's request must carry a fresh, unused proof for this record.
create or replace function private.require_delivery_proof(p_company uuid, p_kind text, p_target uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role  text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  v_token text := coalesce(nullif(current_setting('request.headers', true), '')::jsonb ->> 'x-taviron-delivery-proof', '');
begin
  if v_role not in ('authenticated', 'anon') then
    return; -- the server's own account, migrations and seeds
  end if;
  if v_token !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'This send was not confirmed by the email or accounting service, so it is not recorded as sent.' using errcode = '42501';
  end if;
  update private.delivery_proofs
     set used_at = now()
   where id = v_token::uuid and company_id = p_company and kind = p_kind and target_id = p_target
     and used_at is null and created_at > now() - interval '10 minutes';
  if not found then
    raise exception 'This send was not confirmed by the email or accounting service, so it is not recorded as sent.' using errcode = '42501';
  end if;
end;
$$;
revoke all on function private.require_delivery_proof(uuid, text, uuid) from public, anon, authenticated;

-- Invoices: the moment an invoice is recorded as emailed.
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
create trigger invoice_sent_guard before insert or update of sent_at on public.invoices
  for each row execute function private.invoice_sent_guard();

-- Quotes: an email delivery recorded as sent (or sent to the test address). Manual "mark as sent" is the person's own
-- statement (channel 'manual') and stays as it is.
create or replace function private.quote_email_sent_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.channel = 'email' and new.status::text in ('sent', 'test_sent') then
    perform private.require_delivery_proof(new.company_id, 'quote.sent', new.quote_id);
  end if;
  return new;
end;
$$;
revoke all on function private.quote_email_sent_guard() from public, anon, authenticated;
create trigger quote_email_sent_guard before insert on public.email_deliveries
  for each row execute function private.quote_email_sent_guard();

-- QuickBooks: a real (not simulated) send recorded as done.
create or replace function private.accounting_sent_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'sent' and old.status is distinct from 'sent' and not new.simulated then
    perform private.require_delivery_proof(new.company_id, 'accounting.sent', new.id);
  end if;
  return new;
end;
$$;
revoke all on function private.accounting_sent_guard() from public, anon, authenticated;
create trigger accounting_sent_guard before update of status on public.accounting_invoice_sends
  for each row execute function private.accounting_sent_guard();
