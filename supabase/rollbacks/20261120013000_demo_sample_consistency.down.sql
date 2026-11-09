-- Rollback of 20261120013000_demo_sample_consistency.sql (not a migration; run by hand with a backup first).
-- Restores the two guards and the earlier invoice sample exactly as before and removes the demo timeline function.
-- Times already moved and invoices already issued stay as they are (fictional demo data; nothing else changed).
begin;
drop function if exists public.demo_sample_timeline();
CREATE OR REPLACE FUNCTION private.prevent_modification()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  if tg_op = 'DELETE'
     and current_setting('tlt.sample_purge', true) = 'on'
     and tg_table_name in ('quote_status_events', 'email_deliveries', 'documents', 'order_status_events',
                           'delivery_ticket_events', 'billing_reviews', 'portal_messages') then
    return old;
  end if;
  -- Demo speed history: a ticket history entry's time alone may move, in a demo, inside public.demo_speed_history().
  if tg_op = 'UPDATE' and tg_table_name = 'delivery_ticket_events'
     and private.demo_timing_allowed((to_jsonb(old) ->> 'company_id')::uuid)
     and (to_jsonb(new) - 'occurred_at') = (to_jsonb(old) - 'occurred_at') then
    return new;
  end if;
  raise exception '% rows are append-only and cannot be changed or deleted.', tg_table_name
    using errcode = '42501';
end;
$function$

;
CREATE OR REPLACE FUNCTION private.guard_locked_version()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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
$function$

;
CREATE OR REPLACE FUNCTION public.demo_invoice_samples()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_demo uuid := private.demo_owner_company();
  v_today date;
  r record;
  v_inv uuid;
  v_total bigint;
  v_ready uuid[];
  n integer := 0;
begin
  if v_demo is null then
    raise exception 'Demo samples are only added to a demo company, by its owner.' using errcode = '42501';
  end if;
  if exists (select 1 from public.invoices where company_id = v_demo) then
    return 0;
  end if;
  v_today := private.company_today(v_demo);
  insert into public.invoicing_settings (company_id, issuer, terms_days, footer)
  values (v_demo, 'taviron', 30, 'Thank you for your business. Demo company: this invoice is fictional.')
  on conflict (company_id) do nothing;
  -- Up to three handed-off orders: hand off ready demo orders when there are fewer (as the office would), keeping one ready.
  select array_agg(order_id) into v_ready from (
    select s.order_id from public.billing_order_status s
     where s.company_id = v_demo and s.readiness = 'ready'
     order by s.order_number
     limit greatest(0, least(3 - (select count(*) from public.billing_handoff_orders h where h.company_id = v_demo and h.reverted_at is null),
                             -- always leave one order ready to bill, so Billing still shows that state
                             (select count(*) from public.billing_order_status rs where rs.company_id = v_demo and rs.readiness = 'ready') - 1))) x;
  if coalesce(cardinality(v_ready), 0) > 0 then
    perform public.hand_off_orders(v_ready, 'Demo invoices', 'Handed off so the demo has invoices to show.', gen_random_uuid());
  end if;
  for r in select h.id from public.billing_handoff_orders h
            where h.company_id = v_demo and h.reverted_at is null
              and not exists (select 1 from public.accounting_invoice_sends s where s.handoff_order_id = h.id and s.status = 'sent' and not s.simulated)
            order by h.id limit 3 loop
    v_inv := public.invoice_create(r.id);
    perform public.invoice_issue(v_inv, v_today - case n when 0 then 45 when 1 then 12 else 20 end);
    select total_cents into v_total from public.invoices where id = v_inv;
    if n = 1 and v_total > 1 then
      perform public.invoice_add_payment(v_inv, v_total / 2, v_today - 3, 'check', '1042', 'Partial payment (demo)');
    elsif n = 2 and v_total > 0 then
      perform public.invoice_add_payment(v_inv, v_total, v_today - 5, 'ach', '', 'Paid in full (demo)');
    end if;
    n := n + 1;
  end loop;
  return n;
end;
$function$

;
revoke all on function public.demo_invoice_samples() from public, anon;
grant execute on function public.demo_invoice_samples() to authenticated;
commit;
