-- Payments by delivery ticket (TP1, owner 2026-11-09). Some customers are billed later but pay against specific delivery
-- tickets (their check stub, emailed remittance or bank reference lists ticket numbers). The office records the payment
-- once and says which tickets it covers; each ticket then shows paid, part paid or open, and the invoice balance follows.
--
--   * A ticket's billed amount is its share of what was billed for its order, read from the billing handoff snapshot
--     (the authoritative billed record): each line is split over its tickets by quantity, lines without tickets
--     (flat charges) over the order's tickets by their value, and tax and discount over everything, so the shares add up
--     to the billed total exactly. With billing businesses, each share keeps the business that billed it.
--   * public.customer_payments: the money received (customer, amount, date, method, reference, note).
--   * public.ticket_payment_applications: how much of a payment went to which ticket of which handed-off order.
--     A ticket can be part paid; money not applied stays as the customer's unapplied credit until it is applied.
--   * Companies that invoice from Taviron: applying to tickets also records the matching payment on the issued invoice
--     (public.invoice_payments, linked by customer_payment_id), so balances, statements, aging and the portal follow.
--     Companies that invoice in QuickBooks keep QuickBooks as the record; sending the payment there is a separate,
--     reviewed step.
--   * Voiding a customer payment voids its invoice payments too; those cannot be voided on their own.

-- Largest-remainder split of a whole number of cents by weights; the parts always add up to the total.
create or replace function private.split_cents(p_total bigint, p_weights numeric[])
returns bigint[]
language plpgsql
immutable
set search_path = ''
as $$
declare
  n int := coalesce(array_length(p_weights, 1), 0);
  a bigint := abs(coalesce(p_total, 0));
  sgn int := case when coalesce(p_total, 0) < 0 then -1 else 1 end;
  w numeric[] := '{}';
  s numeric := 0;
  res bigint[] := '{}';
  rem numeric[] := '{}';
  given bigint := 0;
  idx bigint[];
  i int;
begin
  if n = 0 then
    return '{}';
  end if;
  for i in 1 .. n loop
    w[i] := greatest(abs(coalesce(p_weights[i], 0)), 0);
    s := s + w[i];
  end loop;
  if s = 0 then
    for i in 1 .. n loop w[i] := 1; end loop;
    s := n;
  end if;
  for i in 1 .. n loop
    res[i] := floor(a * w[i] / s);
    rem[i] := a * w[i] / s - res[i];
    given := given + res[i];
  end loop;
  select array_agg(t.ord order by t.r desc, t.ord) into idx from unnest(rem) with ordinality as t(r, ord);
  for i in 1 .. (a - given) loop
    res[idx[i]] := res[idx[i]] + 1;
  end loop;
  for i in 1 .. n loop
    res[i] := res[i] * sgn;
  end loop;
  return res;
end;
$$;
revoke all on function private.split_cents(bigint, numeric[]) from public, anon, authenticated;

-- Each ticket's share of a handed-off order's billed total, per billing business (null when the company has none).
create or replace function private.handoff_ticket_shares(p_snapshot jsonb)
returns table (ticket_number text, entity_id uuid, cents bigint)
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_lines   jsonb := coalesce(p_snapshot -> 'lines', '[]'::jsonb);
  v_tickets jsonb := coalesce(p_snapshot -> 'tickets', '[]'::jsonb);
  cells     jsonb := '{}'::jsonb;
  l         jsonb;
  nums      text[];
  w         numeric[];
  parts     bigint[];
  all_nums  text[];
  direct    numeric[] := '{}';
  k         text;
  i         int;
  v_sum     bigint := 0;
  v_total   bigint;
begin
  if jsonb_typeof(v_tickets) <> 'array' or jsonb_array_length(v_tickets) = 0 then
    return;
  end if;
  select array_agg(distinct x ->> 'ticket_number') into all_nums from jsonb_array_elements(v_tickets) x;
  select array_agg(n order by n) into all_nums from unnest(all_nums) n;

  -- Lines delivered by tickets: split over those tickets by quantity.
  for l in select value from jsonb_array_elements(v_lines) loop
    v_sum := v_sum + coalesce((l ->> 'amount_cents')::bigint, 0);
    select array_agg(x ->> 'ticket_number' order by x ->> 'ticket_number'), array_agg(coalesce((x ->> 'quantity')::numeric, 0) order by x ->> 'ticket_number')
      into nums, w
      from jsonb_array_elements(v_tickets) x where x ->> 'order_line_id' = l ->> 'line_id';
    if nums is not null then
      parts := private.split_cents(coalesce((l ->> 'amount_cents')::bigint, 0), w);
      for i in 1 .. array_length(nums, 1) loop
        k := nums[i] || '|' || coalesce(l ->> 'billing_entity_id', '');
        cells := jsonb_set(cells, array[k], to_jsonb(coalesce((cells ->> k)::bigint, 0) + parts[i]));
      end loop;
    end if;
  end loop;

  -- Lines without tickets (flat charges): over the order's tickets by the value they already carry.
  for i in 1 .. array_length(all_nums, 1) loop
    direct[i] := (select coalesce(sum(abs(e.value::bigint)), 0) from jsonb_each_text(cells) e where split_part(e.key, '|', 1) = all_nums[i]);
  end loop;
  for l in select value from jsonb_array_elements(v_lines) loop
    if coalesce((l ->> 'amount_cents')::bigint, 0) <> 0
       and not exists (select 1 from jsonb_array_elements(v_tickets) x where x ->> 'order_line_id' = l ->> 'line_id') then
      parts := private.split_cents((l ->> 'amount_cents')::bigint, direct);
      for i in 1 .. array_length(all_nums, 1) loop
        k := all_nums[i] || '|' || coalesce(l ->> 'billing_entity_id', '');
        cells := jsonb_set(cells, array[k], to_jsonb(coalesce((cells ->> k)::bigint, 0) + parts[i]));
      end loop;
    end if;
  end loop;

  -- Tax and discount (the billed total minus the lines): over every share by its size.
  v_total := coalesce((p_snapshot -> 'order' ->> 'total_cents')::bigint, v_sum);
  if v_total <> v_sum and cells <> '{}'::jsonb then
    select array_agg(e.key order by e.key), array_agg(abs(e.value::bigint)::numeric order by e.key) into nums, w from jsonb_each_text(cells) e;
    parts := private.split_cents(v_total - v_sum, w);
    for i in 1 .. array_length(nums, 1) loop
      cells := jsonb_set(cells, array[nums[i]], to_jsonb((cells ->> nums[i])::bigint + parts[i]));
    end loop;
  end if;

  return query
    select split_part(e.key, '|', 1), nullif(split_part(e.key, '|', 2), '')::uuid, e.value::bigint from jsonb_each_text(cells) e;
end;
$$;
revoke all on function private.handoff_ticket_shares(jsonb) from public, anon, authenticated;

create table public.customer_payments (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null default private.current_company_id() references public.companies (id),
  customer_id   uuid not null,
  amount_cents  bigint not null check (amount_cents > 0),
  received_on   date not null,
  method        text not null check (method in ('check', 'ach', 'card', 'cash', 'other')),
  reference     text not null default '' check (length(reference) <= 80),
  note          text not null default '' check (length(note) <= 300),
  recorded_by   uuid default auth.uid() references auth.users (id) on delete set null,
  created_at    timestamptz not null default now(),
  voided_at     timestamptz,
  voided_by     uuid references auth.users (id) on delete set null,
  void_reason   text not null default '',
  unique (company_id, id),
  foreign key (company_id, customer_id) references public.customers (company_id, id),
  check ((voided_at is null) = (void_reason = ''))
);
create index customer_payments_customer on public.customer_payments (company_id, customer_id, received_on desc);

create table public.ticket_payment_applications (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references public.companies (id),
  payment_id        uuid not null,
  handoff_order_id  uuid not null references public.billing_handoff_orders (id),
  ticket_number     text not null check (length(ticket_number) between 1 and 60),
  amount_cents      bigint not null check (amount_cents > 0),
  created_by        uuid default auth.uid() references auth.users (id) on delete set null,
  created_at        timestamptz not null default now(),
  foreign key (company_id, payment_id) references public.customer_payments (company_id, id) on delete cascade,
  unique (payment_id, handoff_order_id, ticket_number)
);
create index ticket_payment_applications_ticket on public.ticket_payment_applications (company_id, handoff_order_id, ticket_number);

alter table public.invoice_payments add column customer_payment_id uuid references public.customer_payments (id);
create index invoice_payments_customer_payment on public.invoice_payments (customer_payment_id) where customer_payment_id is not null;

alter table public.customer_payments enable row level security;
alter table public.ticket_payment_applications enable row level security;
revoke all on public.customer_payments, public.ticket_payment_applications from anon, authenticated;
grant select on public.customer_payments, public.ticket_payment_applications to authenticated;
create policy customer_payments_read on public.customer_payments for select to authenticated
  using (company_id = (select private.current_company_id()) and (select private.has_permission('billing.view')));
create policy ticket_payment_applications_read on public.ticket_payment_applications for select to authenticated
  using (company_id = (select private.current_company_id()) and (select private.has_permission('billing.view')));

-- An invoice payment that came from a ticket payment is voided with that payment, never on its own.
create or replace function private.invoice_payment_from_ticket_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.customer_payment_id is not null and old.voided_at is null and new.voided_at is not null
     and coalesce(current_setting('taviron.voiding_customer_payment', true), '') <> 'on' then
    raise exception 'This payment came from a payment by ticket. Void it there (Billing → the customer''s payments).' using errcode = '22023';
  end if;
  return new;
end;
$$;
revoke all on function private.invoice_payment_from_ticket_guard() from public, anon, authenticated;
create trigger invoice_payment_from_ticket_guard before update of voided_at on public.invoice_payments
  for each row execute function private.invoice_payment_from_ticket_guard();

-- The issued Taviron invoice that bills a handed-off order (single or combined), if any.
create or replace function private.handoff_issued_invoice(p_handoff uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select i.id from public.invoices i
   where i.status = 'issued'
     and (i.handoff_order_id = p_handoff
          or exists (select 1 from public.invoice_orders io where io.invoice_id = i.id and io.handoff_order_id = p_handoff and io.active))
   order by i.issued_at desc nulls last limit 1;
$$;
revoke all on function private.handoff_issued_invoice(uuid) from public, anon, authenticated;

-- Every billed ticket of a customer with what was billed, applied and is still open (non-reverted handoffs only).
create or replace function private.customer_ticket_rows(p_company uuid, p_customer uuid)
returns table (handoff_order_id uuid, ticket_number text, order_number text, billed_cents bigint, applied_cents bigint)
language sql
stable
security definer
set search_path = ''
as $$
  with shares as (
    select h.id as handoff_order_id, s.ticket_number, h.snapshot -> 'order' ->> 'order_number' as order_number, sum(s.cents)::bigint as billed_cents
      from public.billing_handoff_orders h
      join public.orders o on o.id = h.order_id and o.company_id = h.company_id
      cross join lateral private.handoff_ticket_shares(h.snapshot) s
     where h.company_id = p_company and h.reverted_at is null and o.customer_id = p_customer
     group by h.id, s.ticket_number, h.snapshot -> 'order' ->> 'order_number'
  )
  select sh.handoff_order_id, sh.ticket_number, sh.order_number, sh.billed_cents,
         coalesce((select sum(a.amount_cents) from public.ticket_payment_applications a
                    join public.customer_payments p on p.id = a.payment_id and p.voided_at is null
                   where a.company_id = p_company and a.handoff_order_id = sh.handoff_order_id and a.ticket_number = sh.ticket_number), 0)::bigint
    from shares sh;
$$;
revoke all on function private.customer_ticket_rows(uuid, uuid) from public, anon, authenticated;

-- Money of a payment not yet applied to a ticket of a current (non-reverted) handoff.
create or replace function private.customer_payment_unapplied(p_payment uuid)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select p.amount_cents - coalesce((select sum(a.amount_cents) from public.ticket_payment_applications a
                                      join public.billing_handoff_orders h on h.id = a.handoff_order_id and h.reverted_at is null
                                     where a.payment_id = p.id), 0)
    from public.customer_payments p where p.id = p_payment;
$$;
revoke all on function private.customer_payment_unapplied(uuid) from public, anon, authenticated;

-- A customer's tickets, payments and unapplied credit, for the "Payments by ticket" screen.
create or replace function public.customer_ticket_balances(p_customer uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v_issuer  text;
begin
  perform private.require_permission('billing.view');
  if not exists (select 1 from public.customers c where c.id = p_customer and c.company_id = v_company) then
    raise exception 'Customer not found.' using errcode = 'P0002';
  end if;
  select coalesce(s.issuer, 'quickbooks') into v_issuer from public.invoicing_settings s where s.company_id = v_company;
  return jsonb_build_object(
    'issuer', coalesce(v_issuer, 'quickbooks'),
    'tickets', coalesce((
      select jsonb_agg(jsonb_build_object(
               'handoff_order_id', r.handoff_order_id, 'ticket_number', r.ticket_number, 'order_number', r.order_number,
               'billed_cents', r.billed_cents, 'applied_cents', r.applied_cents, 'open_cents', r.billed_cents - r.applied_cents,
               'delivered_at', t.delivered_at, 'reference', coalesce(t.external_reference, ''),
               'invoice_number', (select i.number from public.invoices i where i.id = private.handoff_issued_invoice(r.handoff_order_id)),
               -- What is still unpaid on that invoice, whoever paid it (a payment recorded on the invoice itself counts too).
               'invoice_open_cents', (select i.total_cents - private.invoice_paid_cents(i.id) from public.invoices i where i.id = private.handoff_issued_invoice(r.handoff_order_id)),
               'qbo_numbers', (select coalesce(jsonb_agg(s.external_number order by s.external_number), '[]'::jsonb) from public.accounting_invoice_sends s
                                where s.handoff_order_id = r.handoff_order_id and s.status = 'sent'))
             order by t.delivered_at nulls last, r.ticket_number)
        from private.customer_ticket_rows(v_company, p_customer) r
        left join lateral (select dt.delivered_at, dt.external_reference from public.delivery_tickets dt
                            where dt.company_id = v_company and dt.ticket_number = r.ticket_number and dt.status::text <> 'void'
                            order by dt.revision desc limit 1) t on true), '[]'::jsonb),
    'payments', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', p.id, 'amount_cents', p.amount_cents, 'received_on', p.received_on, 'method', p.method, 'reference', p.reference,
               'note', p.note, 'voided', p.voided_at is not null, 'void_reason', p.void_reason,
               'unapplied_cents', case when p.voided_at is null then private.customer_payment_unapplied(p.id) else 0 end,
               'tickets', (select coalesce(jsonb_agg(jsonb_build_object('ticket_number', a.ticket_number, 'amount_cents', a.amount_cents) order by a.ticket_number), '[]'::jsonb)
                             from public.ticket_payment_applications a where a.payment_id = p.id))
             order by p.received_on desc, p.created_at desc)
        from (select * from public.customer_payments cp where cp.company_id = v_company and cp.customer_id = p_customer
               order by cp.received_on desc, cp.created_at desc limit 50) p), '[]'::jsonb),
    'unapplied_cents', coalesce((select sum(private.customer_payment_unapplied(cp.id)) from public.customer_payments cp
                                  where cp.company_id = v_company and cp.customer_id = p_customer and cp.voided_at is null), 0)
  );
end;
$$;
revoke all on function public.customer_ticket_balances(uuid) from public, anon;
grant execute on function public.customer_ticket_balances(uuid) to authenticated;

-- Applies part of a payment to tickets: [{handoff_order_id, ticket_number, amount_cents}, ...]. Shared by record and apply.
create or replace function private.apply_customer_payment(p_payment uuid, p_apps jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  p          public.customer_payments%rowtype;
  v_issuer   text;
  a          jsonb;
  v_handoff  uuid;
  v_ticket   text;
  v_amount   bigint;
  v_open     bigint;
  v_total    bigint := 0;
  v_invoice  uuid;
  v_balance  bigint;
  g          record;
  v_new      jsonb := '[]'::jsonb;
begin
  select * into p from public.customer_payments where id = p_payment for update;
  if jsonb_typeof(p_apps) <> 'array' then
    raise exception 'Choose the tickets this payment covers.' using errcode = '22023';
  end if;
  if jsonb_array_length(p_apps) > 500 then
    raise exception 'Apply at most 500 tickets at a time.' using errcode = '22023';
  end if;
  select coalesce(s.issuer, 'quickbooks') into v_issuer from public.invoicing_settings s where s.company_id = p.company_id;
  for a in select value from jsonb_array_elements(p_apps) loop
    begin
      v_handoff := (a ->> 'handoff_order_id')::uuid;
      v_amount := (a ->> 'amount_cents')::bigint;
    exception when others then
      raise exception 'A ticket line is not valid.' using errcode = '22023';
    end;
    v_ticket := btrim(coalesce(a ->> 'ticket_number', ''));
    if v_amount is null or v_amount <= 0 then
      raise exception 'Enter an amount for ticket %.', v_ticket using errcode = '22023';
    end if;
    select r.billed_cents - r.applied_cents into v_open
      from private.customer_ticket_rows(p.company_id, p.customer_id) r
     where r.handoff_order_id = v_handoff and r.ticket_number = v_ticket;
    if not found then
      raise exception 'Ticket % is not a billed ticket of this customer.', v_ticket using errcode = '22023';
    end if;
    if v_amount > v_open then
      raise exception 'Ticket % has only % left to pay.', v_ticket, to_char(v_open / 100.0, 'FM$999,999,990.00') using errcode = '22023';
    end if;
    if v_issuer = 'taviron' and private.handoff_issued_invoice(v_handoff) is null then
      raise exception 'Ticket % is not on an issued invoice yet. Issue the invoice first.', v_ticket using errcode = '22023';
    end if;
    insert into public.ticket_payment_applications (company_id, payment_id, handoff_order_id, ticket_number, amount_cents)
    values (p.company_id, p.id, v_handoff, v_ticket, v_amount)
    on conflict (payment_id, handoff_order_id, ticket_number) do update set amount_cents = public.ticket_payment_applications.amount_cents + excluded.amount_cents;
    v_new := v_new || jsonb_build_array(jsonb_build_object('handoff_order_id', v_handoff, 'amount_cents', v_amount));
    v_total := v_total + v_amount;
  end loop;
  if private.customer_payment_unapplied(p.id) < 0 then
    raise exception 'The tickets add up to more than the payment.' using errcode = '22023';
  end if;

  -- Taviron invoices: the same money recorded on each issued invoice those tickets are billed on.
  if v_issuer = 'taviron' then
    for g in select private.handoff_issued_invoice((n ->> 'handoff_order_id')::uuid) as invoice_id, sum((n ->> 'amount_cents')::bigint)::bigint as amount
               from jsonb_array_elements(v_new) n group by 1 loop
      select i.total_cents - private.invoice_paid_cents(i.id) into v_balance from public.invoices i where i.id = g.invoice_id;
      if g.amount > v_balance then
        raise exception 'Invoice % has only % left to pay.', (select number from public.invoices where id = g.invoice_id),
          to_char(v_balance / 100.0, 'FM$999,999,990.00') using errcode = '22023';
      end if;
      insert into public.invoice_payments (company_id, invoice_id, amount_cents, received_on, method, reference, note, customer_payment_id)
      values (p.company_id, g.invoice_id, g.amount, p.received_on, p.method, p.reference, left(btrim('By ticket. ' || p.note), 300), p.id);
    end loop;
  end if;
  perform private.log_event('payment.applied', 'customer', p.customer_id,
    format('%s of a payment applied to %s ticket(s)', to_char(v_total / 100.0, 'FM$999,999,990.00'), jsonb_array_length(p_apps)),
    jsonb_build_object('payment_id', p.id, 'amount_cents', v_total));
end;
$$;
revoke all on function private.apply_customer_payment(uuid, jsonb) from public, anon, authenticated;

-- Record a payment and the tickets it covers (all or part; the rest stays as unapplied credit).
create or replace function public.customer_payment_record(p jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v_customer uuid;
  v_amount bigint;
  v_received date;
  v_method text := coalesce(p ->> 'method', '');
  v_id uuid;
begin
  perform private.require_permission('billing.manage');
  begin
    v_customer := (p ->> 'customer_id')::uuid;
    v_amount := (p ->> 'amount_cents')::bigint;
    v_received := (p ->> 'received_on')::date;
  exception when others then
    raise exception 'Check the amount and the date.' using errcode = '22023';
  end;
  if not exists (select 1 from public.customers c where c.id = v_customer and c.company_id = v_company) then
    raise exception 'Customer not found.' using errcode = 'P0002';
  end if;
  if v_amount is null or v_amount <= 0 or v_amount > 100000000000 then
    raise exception 'Enter the amount received.' using errcode = '22023';
  end if;
  if v_received is null or v_received > private.company_today(v_company) or v_received < private.company_today(v_company) - 730 then
    raise exception 'Enter the date the payment was received (not in the future).' using errcode = '22023';
  end if;
  if v_method not in ('check', 'ach', 'card', 'cash', 'other') then
    raise exception 'Choose how it was paid.' using errcode = '22023';
  end if;
  insert into public.customer_payments (company_id, customer_id, amount_cents, received_on, method, reference, note)
  values (v_company, v_customer, v_amount, v_received, v_method,
          private.clean_text(p ->> 'reference', 80, 'Reference'), private.clean_text(p ->> 'note', 300, 'Note'))
  returning id into v_id;
  perform private.log_event('payment.received', 'customer', v_customer,
    format('Payment of %s received', to_char(v_amount / 100.0, 'FM$999,999,990.00')),
    jsonb_build_object('payment_id', v_id, 'amount_cents', v_amount, 'method', v_method));
  if jsonb_array_length(coalesce(p -> 'tickets', '[]'::jsonb)) > 0 then
    perform private.apply_customer_payment(v_id, p -> 'tickets');
  end if;
  return v_id;
end;
$$;
revoke all on function public.customer_payment_record(jsonb) from public, anon;
grant execute on function public.customer_payment_record(jsonb) to authenticated;

-- Apply a payment's unapplied credit to more tickets.
create or replace function public.customer_payment_apply(p_payment uuid, p_tickets jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  p public.customer_payments%rowtype;
begin
  perform private.require_permission('billing.manage');
  select * into p from public.customer_payments where id = p_payment and company_id = private.require_company() for update;
  if not found then
    raise exception 'Payment not found.' using errcode = 'P0002';
  end if;
  if p.voided_at is not null then
    raise exception 'This payment is void.' using errcode = '22023';
  end if;
  perform private.apply_customer_payment(p.id, p_tickets);
end;
$$;
revoke all on function public.customer_payment_apply(uuid, jsonb) from public, anon;
grant execute on function public.customer_payment_apply(uuid, jsonb) to authenticated;

-- Void a payment (bounced check, entered twice): its tickets reopen and its invoice payments are voided with it.
create or replace function public.customer_payment_void(p_payment uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  p public.customer_payments%rowtype;
  v_reason text := private.clean_text(p_reason, 300, 'Reason');
begin
  perform private.require_permission('billing.manage');
  select * into p from public.customer_payments where id = p_payment and company_id = private.require_company() for update;
  if not found then
    raise exception 'Payment not found.' using errcode = 'P0002';
  end if;
  if p.voided_at is not null then
    raise exception 'This payment is already void.' using errcode = '22023';
  end if;
  if v_reason = '' then
    raise exception 'Give a reason for voiding the payment.' using errcode = '22023';
  end if;
  update public.customer_payments set voided_at = now(), voided_by = auth.uid(), void_reason = v_reason where id = p.id;
  perform set_config('taviron.voiding_customer_payment', 'on', true);
  update public.invoice_payments set voided_at = now(), voided_by = auth.uid(), void_reason = left('Payment by ticket voided: ' || v_reason, 300)
   where customer_payment_id = p.id and voided_at is null;
  perform set_config('taviron.voiding_customer_payment', '', true);
  perform private.log_event('payment.voided', 'customer', p.customer_id,
    format('Payment of %s voided: %s', to_char(p.amount_cents / 100.0, 'FM$999,999,990.00'), v_reason), jsonb_build_object('payment_id', p.id));
end;
$$;
revoke all on function public.customer_payment_void(uuid, text) from public, anon;
grant execute on function public.customer_payment_void(uuid, text) to authenticated;

-- Demo sample (shared by the presenter seed, the prospect seeds and Refresh; demo companies only, once): a check that
-- pays one ticket of a partly paid invoice in full and another in part, with a little left over as the customer's
-- credit, so "Payments by ticket" shows paid, part-paid and open tickets and an unapplied credit. Fictional; nothing is
-- sent anywhere.
create or replace function public.demo_ticket_payment_samples()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_demo   uuid := private.demo_owner_company();
  v_today  date;
  v_inv    record;
  v_t      record;
  v_budget bigint;
  v_take   bigint;
  v_sum    bigint := 0;
  v_list   jsonb := '[]'::jsonb;
  i        integer := 0;
begin
  if v_demo is null then
    raise exception 'Demo samples are only added to a demo company, by its owner.' using errcode = '42501';
  end if;
  if exists (select 1 from public.customer_payments where company_id = v_demo) then
    return 0;
  end if;
  v_today := private.company_today(v_demo);
  -- An issued invoice with money still owed: the partly paid one first; never the only unpaid past-due invoice.
  select inv.id, io.handoff_order_id, o.customer_id, inv.total_cents - private.invoice_paid_cents(inv.id) as balance
    into v_inv
    from public.invoices inv
    join public.invoice_orders io on io.invoice_id = inv.id
    join public.billing_handoff_orders h on h.id = io.handoff_order_id and h.reverted_at is null
    join public.orders o on o.id = h.order_id and o.company_id = h.company_id
   where inv.company_id = v_demo and inv.status = 'issued'
     and inv.total_cents - private.invoice_paid_cents(inv.id) > 100
     and (private.invoice_paid_cents(inv.id) > 0 or inv.due_date >= v_today)
     and exists (select 1 from private.handoff_ticket_shares(h.snapshot))
   order by (private.invoice_paid_cents(inv.id) > 0) desc, inv.issued_at desc
   limit 1;
  if v_inv.id is null then
    return 0;
  end if;
  v_budget := v_inv.balance;
  for v_t in select r.ticket_number, r.billed_cents - r.applied_cents as open_cents
               from private.customer_ticket_rows(v_demo, v_inv.customer_id) r
              where r.handoff_order_id = v_inv.handoff_order_id and r.billed_cents > r.applied_cents
              order by r.ticket_number limit 2 loop
    -- The first ticket in full, the second in part.
    v_take := least(case when i = 0 then v_t.open_cents else greatest(1, v_t.open_cents / 2) end, v_budget - v_sum);
    exit when v_take <= 0;
    v_list := v_list || jsonb_build_object('handoff_order_id', v_inv.handoff_order_id, 'ticket_number', v_t.ticket_number, 'amount_cents', v_take);
    v_sum := v_sum + v_take;
    i := i + 1;
  end loop;
  if i = 0 then
    return 0;
  end if;
  perform public.customer_payment_record(jsonb_build_object(
    'customer_id', v_inv.customer_id, 'amount_cents', v_sum + 2500, 'received_on', v_today - 2, 'method', 'check',
    'reference', '20417', 'note', 'Check stub lists the ticket numbers (demo).', 'tickets', v_list));
  return 1;
end;
$$;
revoke all on function public.demo_ticket_payment_samples() from public, anon;
grant execute on function public.demo_ticket_payment_samples() to authenticated;
