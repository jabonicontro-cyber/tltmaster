-- =============================================================================
-- Demo sample consistency (owner 2026-11-09: demo data that would look wrong to a prospect).
--
-- 1. Sample invoices follow their deliveries. public.demo_invoice_samples() invoices the oldest handed-off orders
--    first and dates every invoice on or after the order's last accepted delivery (never before it). The past-due,
--    unpaid example is honest: Refresh first adds one sample order delivered about six weeks ago (accepted tickets,
--    handed off, src/server/demo/samples.ts pastDueOrder), so its invoice, issued the day after that delivery with
--    the demo's 30-day terms, is genuinely past due. Payments are dated on or after their invoice.
-- 2. Sample history times follow the sample dates. public.demo_sample_timeline() moves, in a demo only:
--    * the sample quote history (project names "Quote history (demo) …" and "Pricing history (demo) …"): issued and
--      sent on the quote date, decided within the validity (expired ones the day after they expired), with the
--      matching status history, the manual "handed over" record and the accepted quote's order creation;
--    * order status history stamped after the order was already delivering (the seed creates back-dated orders and
--      confirms and schedules them in the same second): Created, Confirmed and Scheduled move to the afternoon
--      before the order's first delivery day.
--    Only times change, never who, what, amounts or statuses (the same rule as public.demo_speed_history()).
--
-- Safety:
-- * Only the active owner of an active demo company can run either function (private.demo_owner_company()); real
--   companies are refused. Called by "Refresh demo data" and the demo seeds through src/server/demo/samples.ts.
-- * The append-only and issued-quote guards allow a time-only change only inside this transaction (tlt.demo_timing,
--   set locally) and only for demo companies (private.demo_timing_allowed). Every other change is refused as before.
-- * Idempotent: only records still carrying seed-time stamps are moved (sent after the quote date; created, confirmed
--   or scheduled after the order's first delivery), so a second run changes nothing. demo_invoice_samples still adds
--   invoices only while the demo has none; existing demo invoices are never changed.
--
-- Reversible: supabase/rollbacks/20261120013000_demo_sample_consistency.down.sql (restores the guards and the earlier
-- invoice sample, removes the timeline function; times already moved stay, which is harmless demo data).
-- =============================================================================

-- Append-only history: a demo's order and quote status history and manual quote hand-over records may have their time
-- moved inside public.demo_sample_timeline(), like ticket history inside public.demo_speed_history().
create or replace function private.prevent_modification()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE'
     and current_setting('tlt.sample_purge', true) = 'on'
     and tg_table_name in ('quote_status_events', 'email_deliveries', 'documents', 'order_status_events',
                           'delivery_ticket_events', 'billing_reviews', 'portal_messages') then
    return old;
  end if;
  -- Demo timings: a history entry's time alone may move, in a demo, inside public.demo_speed_history() or
  -- public.demo_sample_timeline().
  if tg_op = 'UPDATE' and tg_table_name in ('delivery_ticket_events', 'order_status_events', 'quote_status_events')
     and private.demo_timing_allowed((to_jsonb(old) ->> 'company_id')::uuid)
     and (to_jsonb(new) - 'occurred_at') = (to_jsonb(old) - 'occurred_at') then
    return new;
  end if;
  if tg_op = 'UPDATE' and tg_table_name = 'email_deliveries'
     and private.demo_timing_allowed((to_jsonb(old) ->> 'company_id')::uuid)
     and (to_jsonb(new) - 'created_at') = (to_jsonb(old) - 'created_at') then
    return new;
  end if;
  raise exception '% rows are append-only and cannot be changed or deleted.', tg_table_name
    using errcode = '42501';
end;
$$;

-- Issued quote versions: unchanged, except that a demo's issue and sent times alone may move inside
-- public.demo_sample_timeline().
create or replace function private.guard_locked_version()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_old jsonb;
  v_new jsonb;
  v_allowed constant text[] := array['sent_at', 'updated_at'];
begin
  if tg_op = 'DELETE' then
    -- tlt.sample_purge is only set inside public.remove_sample_data(), which
    -- deletes nothing but sample quotes.
    if old.locked_at is not null and current_setting('tlt.sample_purge', true) is distinct from 'on' then
      raise exception 'Quote % version % has been issued and cannot be deleted.', old.quote_id, old.version_no
        using errcode = '42501';
    end if;
    return old;
  end if;

  if old.locked_at is null then
    return new;
  end if;

  if new.locked_at is null and current_setting('tlt.allow_version_unlock', true) = 'on' and old.sent_at is null then
    return new;
  end if;

  if new.locked_at is not null and private.demo_timing_allowed(old.company_id)
     and (to_jsonb(new) - 'sent_at' - 'locked_at' - 'updated_at') = (to_jsonb(old) - 'sent_at' - 'locked_at' - 'updated_at') then
    return new;
  end if;

  v_old := to_jsonb(old) - v_allowed;
  v_new := to_jsonb(new) - v_allowed;
  if v_old <> v_new then
    raise exception 'This quote version has been issued and cannot be changed. Create a revision instead.'
      using errcode = '42501';
  end if;
  if old.sent_at is not null and new.sent_at is distinct from old.sent_at then
    raise exception 'The sent time of an issued version cannot be changed.' using errcode = '42501';
  end if;
  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- Demo sample: Taviron issues the demo's invoices; up to three handed-off orders become invoices, oldest delivery
-- first — the oldest past due and unpaid when its delivery is old enough, one partly paid, one paid — so Invoices and
-- Receivables show every state. Every invoice is dated on or after its order's last delivery. Fictional; nothing is sent.
-- -----------------------------------------------------------------------------
create or replace function public.demo_invoice_samples()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_demo uuid := private.demo_owner_company();
  v_today date;
  v_tz text;
  r record;
  v_inv uuid;
  v_total bigint;
  v_ready uuid[];
  v_issue date;
  n integer := 0;
begin
  if v_demo is null then
    raise exception 'Demo samples are only added to a demo company, by its owner.' using errcode = '42501';
  end if;
  if exists (select 1 from public.invoices where company_id = v_demo) then
    return 0;
  end if;
  v_today := private.company_today(v_demo);
  select coalesce(nullif(s.timezone, ''), 'America/Chicago') into v_tz from public.company_settings s where s.company_id = v_demo;
  v_tz := coalesce(v_tz, 'America/Chicago');
  insert into public.invoicing_settings (company_id, issuer, terms_days, footer)
  values (v_demo, 'taviron', 30, 'Thank you for your business. Demo company: this invoice is fictional.')
  on conflict (company_id) do nothing;
  -- Up to three handed-off orders: hand off ready demo orders when there are fewer (as the office would), oldest
  -- delivery first, keeping one ready.
  select array_agg(order_id) into v_ready from (
    select s.order_id from public.billing_order_status s
     where s.company_id = v_demo and s.readiness = 'ready'
     order by (select max(t.delivered_at) from public.delivery_tickets t
                where t.company_id = v_demo and t.order_id = s.order_id and t.status = 'accepted') nulls last, s.order_number
     limit greatest(0, least(3 - (select count(*) from public.billing_handoff_orders h where h.company_id = v_demo and h.reverted_at is null),
                             -- always leave one order ready to bill, so Billing still shows that state
                             (select count(*) from public.billing_order_status rs where rs.company_id = v_demo and rs.readiness = 'ready') - 1))) x;
  if coalesce(cardinality(v_ready), 0) > 0 then
    perform public.hand_off_orders(v_ready, 'Demo invoices', 'Handed off so the demo has invoices to show.', gen_random_uuid());
  end if;
  -- Oldest delivery first: the last accepted delivery of each order (its service end when it has none).
  for r in select h.id, x.last_day
             from public.billing_handoff_orders h
             cross join lateral (
               select coalesce(max((t.delivered_at at time zone v_tz)::date), (h.snapshot -> 'order' ->> 'service_end')::date, v_today) as last_day
                 from public.delivery_tickets t
                where t.company_id = v_demo and t.order_id = h.order_id and t.status = 'accepted') x
            where h.company_id = v_demo and h.reverted_at is null
              and not exists (select 1 from public.accounting_invoice_sends s where s.handoff_order_id = h.id and s.status = 'sent' and not s.simulated)
            order by x.last_day, h.id limit 3 loop
    v_inv := public.invoice_create(r.id);
    -- The day after the last delivery (the office bills the next morning), never before it and never in the future;
    -- the later ones a few days back when they can be, so their payments fall after the invoice.
    v_issue := least(r.last_day + 1, v_today);
    if n > 0 then
      v_issue := greatest(r.last_day, least(v_issue, v_today - 3));
    end if;
    v_issue := greatest(v_issue, v_today - 90);
    perform public.invoice_issue(v_inv, v_issue);
    select total_cents into v_total from public.invoices where id = v_inv;
    if n = 1 and v_total > 1 then
      perform public.invoice_add_payment(v_inv, v_total / 2, greatest(v_issue, v_today - 3), 'check', '1042', 'Partial payment (demo)');
    elsif n = 2 and v_total > 0 then
      perform public.invoice_add_payment(v_inv, v_total, greatest(v_issue, v_today - 2), 'ach', '', 'Paid in full (demo)');
    end if;
    n := n + 1;
  end loop;
  return n;
end;
$$;

revoke all on function public.demo_invoice_samples() from public, anon;
grant execute on function public.demo_invoice_samples() to authenticated;

-- -----------------------------------------------------------------------------
-- Demo sample timeline: sample quote history and back-dated sample orders get history times that match their dates.
-- Returns the number of records whose time moved (0 on a second run).
-- -----------------------------------------------------------------------------
create or replace function public.demo_sample_timeline()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_demo uuid := private.demo_owner_company();
  v_tz text;
  v_now timestamptz := now();
  r record;
  v_created timestamptz;
  v_sent timestamptz;
  v_decided timestamptz;
  k integer;
  n integer := 0;
begin
  if v_demo is null then
    raise exception 'Demo timings are only added to a demo company, by its owner.' using errcode = '42501';
  end if;
  select coalesce(nullif(s.timezone, ''), 'America/Chicago') into v_tz from public.company_settings s where s.company_id = v_demo;
  v_tz := coalesce(v_tz, 'America/Chicago');
  perform set_config('tlt.demo_timing', 'on', true);

  -- Sample quote history: issued and sent on the quote date, decided within the validity.
  for r in select q.id as quote_id, q.status, v.id as version_id, v.quote_date, v.valid_until
             from public.quotes q
             join public.quote_versions v on v.id = q.current_version_id and v.company_id = q.company_id
            where q.company_id = v_demo
              and (v.project_name like 'Quote history (demo)%' or v.project_name like 'Pricing history (demo)%')
              and v.sent_at is not null
              and (v.sent_at at time zone v_tz)::date > v.quote_date loop
    v_created := (r.quote_date + time '09:00') at time zone v_tz;
    v_sent := (r.quote_date + time '15:00') at time zone v_tz;
    v_decided := least(v_now, case when r.status = 'expired' then ((r.valid_until + 1) + time '06:00') at time zone v_tz
                                    else (least(r.quote_date + 6, r.valid_until) + time '10:30') at time zone v_tz end);
    update public.quote_versions set locked_at = v_sent, sent_at = v_sent where id = r.version_id and company_id = v_demo;
    update public.quotes
       set created_at = v_created, first_sent_at = v_sent, last_sent_at = v_sent,
           accepted_at = case when accepted_at is not null then v_decided end,
           closed_at = case when closed_at is not null then v_decided end
     where id = r.quote_id and company_id = v_demo;
    update public.quote_status_events e
       set occurred_at = case when e.to_status = 'draft' then v_created when e.to_status = 'sent' then v_sent else v_decided end
     where e.company_id = v_demo and e.quote_id = r.quote_id and e.occurred_at > v_sent;
    update public.email_deliveries d set created_at = v_sent
     where d.company_id = v_demo and d.quote_id = r.quote_id and d.channel = 'manual' and d.created_at > v_sent;
    -- The accepted quote's order was created and confirmed when the quote was accepted.
    update public.order_status_events e
       set occurred_at = v_decided + case when e.to_status = 'draft' then interval '1 minute' else interval '2 minutes' end
     where e.company_id = v_demo and e.to_status in ('draft', 'confirmed') and e.occurred_at > v_decided + interval '1 day'
       and e.order_id in (select o.id from public.orders o where o.company_id = v_demo and o.source_quote_id = r.quote_id);
    n := n + 1;
  end loop;

  -- Back-dated sample orders: Created, Confirmed and Scheduled stamped after the order was already delivering move to
  -- the afternoon before its first delivery day.
  with o as (
    select o.id,
           least(o.order_date, min(l.load_date)) as first_day,
           least((((min(l.load_date) + 1)::timestamp) at time zone v_tz),
                 coalesce((select min(t.delivered_at) from public.delivery_tickets t
                            where t.company_id = v_demo and t.order_id = o.id and t.status <> 'voided'), 'infinity'::timestamptz)) as cut
      from public.orders o
      join public.order_loads l on l.company_id = o.company_id and l.order_id = o.id
     where o.company_id = v_demo
     group by o.id, o.order_date)
  update public.order_status_events e
     set occurred_at = (((o.first_day - 1) + time '14:00') at time zone v_tz)
                       + case e.to_status when 'draft' then interval '0 minutes' when 'confirmed' then interval '20 minutes' else interval '45 minutes' end
    from o
   where e.company_id = v_demo and e.order_id = o.id
     and e.to_status in ('draft', 'confirmed', 'scheduled')
     and e.occurred_at > o.cut;
  get diagnostics k = row_count;
  return n + k;
end;
$$;

revoke all on function public.demo_sample_timeline() from public, anon;
grant execute on function public.demo_sample_timeline() to authenticated;
