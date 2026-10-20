-- Rollback of 20261120001300_reference_numbers.sql. Not destructive: records already numbered ORD-/QTE-/TKT-/BIL-/
-- CUS-/MWO- keep their references (they remain unique). Sequences return to the previous platform format only where
-- they are still on the new standard; customized ones are left alone. Run with psql -v ON_ERROR_STOP=1 -1 -f.
--
-- After a rollback the old format can collide only if the year-based numbers were restarted; next_value is kept at
-- or above its current value, so year-based sequences continue upwards in the current year.

drop trigger if exists document_sequences_guard on public.document_sequences;
drop trigger if exists document_sequences_standard on public.document_sequences;

update public.document_sequences d
   set prefix = case d.key when 'order' then 'O-' when 'quote' then 'Q-' when 'ticket' then 'T-' when 'billing' then 'B-'
                           when 'customer' then 'C-' when 'work_order' then 'WO-' end,
       include_year = d.key <> 'customer',
       pad = case when d.key in ('ticket', 'customer') then 5 else 4 end,
       updated_at = now()
 where (d.key, d.prefix, d.include_year, d.pad) in (('order', 'ORD-', false, 4), ('quote', 'QTE-', false, 4), ('ticket', 'TKT-', false, 4),
       ('billing', 'BIL-', false, 4), ('customer', 'CUS-', false, 4), ('work_order', 'MWO-', false, 4));

drop index if exists public.orders_ref_key, public.quotes_ref_key, public.delivery_tickets_ref_key, public.customers_ref_key,
  public.billing_handoffs_ref_key, public.work_orders_ref_key;
alter table public.orders drop column if exists order_ref_key;
alter table public.quotes drop column if exists quote_ref_key;
alter table public.delivery_tickets drop column if exists ticket_ref_key;
alter table public.customers drop column if exists customer_ref_key;
alter table public.billing_handoffs drop column if exists batch_ref_key;
alter table public.work_orders drop column if exists work_order_ref_key;

create or replace function private.next_document_number(p_company_id uuid, p_key text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_seq   public.document_sequences%rowtype;
  v_year  integer := extract(year from (now() at time zone private.business_timezone(p_company_id)))::integer;
  v_value bigint;
begin
  select * into v_seq from public.document_sequences
  where company_id = p_company_id and key = p_key
  for update;
  if not found then
    raise exception 'Unknown document sequence % for this company', p_key;
  end if;

  if v_seq.include_year and v_seq.current_year is distinct from v_year then
    v_value := 1;
  else
    v_value := v_seq.next_value;
  end if;

  perform set_config('tlt.number_allocation', 'on', true);
  update public.document_sequences
     set next_value = v_value + 1,
         current_year = v_year
   where company_id = p_company_id and key = p_key;
  perform set_config('tlt.number_allocation', 'off', true);

  return v_seq.prefix
      || case when v_seq.include_year then v_year::text || '-' else '' end
      || lpad(v_value::text, v_seq.pad, '0');
end;
$$;

drop function if exists private.document_sequence_guard();
drop function if exists private.document_sequence_standard();
drop function if exists private.reference_in_use(uuid, text, text);
drop function if exists private.reference_legacy_default(text, text, boolean, integer);
drop function if exists private.reference_standard(text);
