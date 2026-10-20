-- =============================================================================
-- Human-readable reference numbers (docs/REFERENCE_NUMBERS.md).
--
-- Audit (2026-10-20): every reference is already issued by one server-side generator, private.next_document_number,
-- which locks the company's sequence row (SELECT ... FOR UPDATE) so concurrent requests are serialized, and rolls back
-- with the transaction that used it. Each table has a per-company unique constraint on its reference. The platform
-- defaults embedded the year (O-2026-0001, Q-2026-0001, T-2026-00001, B-2026-0001, WO-2026-0001, C-00001).
-- There is no issued-invoice table: invoice drafts are previews and billing hand-off batches (B-…) are the only
-- billing records, so no invoice number has ever been issued and none is changed here.
--
-- This migration:
--   1. New platform standard for NEW records: ORD-1001, QTE-1001, TKT-1001, BIL-1001, CUS-1001, MWO-1001 (prefix,
--      hyphen, four digits from 1001, no year). Applied only to sequences still on the old platform default and to
--      companies created later; a sequence a company customized is left exactly as it is. Existing references are
--      never renumbered (the new prefixes cannot collide with the old ones).
--   2. Never reissue: the generator skips any value already used by the company for that record type (e.g. after an
--      administrator changed the format back), and the next number can no longer be lowered by hand.
--   3. Search keys: a stored, indexed upper-case key without punctuation on each referenced table, so ORD1042,
--      ord-1042, O-2026-0001 and O20260001 all find their record (search still runs with the person's own session
--      and row-level security).
-- Primary keys, foreign keys and existing reference values are unchanged.
-- Rollback: supabase/rollbacks/20261120001300_reference_numbers.down.sql (not destructive: references issued in the
-- new format stay as they are).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Formats
-- -----------------------------------------------------------------------------

/** The platform standard for a record type: prefix, width, first number. */
create or replace function private.reference_standard(p_key text, out prefix text, out pad integer, out first_value bigint)
language sql
immutable
set search_path = ''
as $$
  select case p_key
           when 'order' then 'ORD-' when 'quote' then 'QTE-' when 'ticket' then 'TKT-'
           when 'billing' then 'BIL-' when 'customer' then 'CUS-' when 'work_order' then 'MWO-' end,
         4, 1001::bigint;
$$;

/** True when a sequence row still has the old platform default for its record type (never customized). */
create or replace function private.reference_legacy_default(p_key text, p_prefix text, p_include_year boolean, p_pad integer)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select (p_key, p_prefix, p_include_year, p_pad) in (
    ('order', 'O-', true, 4), ('quote', 'Q-', true, 4), ('ticket', 'T-', true, 5), ('billing', 'B-', true, 4),
    ('customer', 'C-', false, 5), ('work_order', 'WO-', true, 4));
$$;

-- New companies (every creation path inserts its sequences with the old defaults): store the new standard instead.
create or replace function private.document_sequence_standard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  s record;
begin
  if private.reference_legacy_default(new.key, new.prefix, new.include_year, new.pad) then
    s := private.reference_standard(new.key);
    new.prefix := s.prefix;
    new.include_year := false;
    new.pad := s.pad;
    new.next_value := greatest(new.next_value, s.first_value);
  end if;
  return new;
end;
$$;
drop trigger if exists document_sequences_standard on public.document_sequences;
create trigger document_sequences_standard before insert on public.document_sequences
  for each row execute function private.document_sequence_standard();

-- Existing companies: sequences still on the old default switch to the new standard for new records (audited by
-- the existing change trigger as a manual change, which it is: a platform release).
update public.document_sequences d
   set prefix = (private.reference_standard(d.key)).prefix,
       include_year = false,
       pad = (private.reference_standard(d.key)).pad,
       next_value = greatest(d.next_value, (private.reference_standard(d.key)).first_value),
       updated_at = now()
 where private.reference_legacy_default(d.key, d.prefix, d.include_year, d.pad);

-- -----------------------------------------------------------------------------
-- 2. Never reissue
-- -----------------------------------------------------------------------------

/** Is this reference already used by the company for this record type? */
create or replace function private.reference_in_use(p_company uuid, p_key text, p_value text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_used boolean;
begin
  execute format('select exists (select 1 from public.%I where company_id = $1 and %I = $2)',
    case p_key when 'order' then 'orders' when 'quote' then 'quotes' when 'ticket' then 'delivery_tickets'
               when 'billing' then 'billing_handoffs' when 'customer' then 'customers' when 'work_order' then 'work_orders' end,
    case p_key when 'order' then 'order_number' when 'quote' then 'quote_number' when 'ticket' then 'ticket_number'
               when 'billing' then 'batch_number' when 'customer' then 'customer_number' when 'work_order' then 'number' end)
    into v_used using p_company, p_value;
  return v_used;
end;
$$;
revoke all on function private.reference_in_use(uuid, text, text) from public, anon, authenticated;

-- Same contract as before (internal only; callers pass a company they verified). One locked row per company and
-- record type serializes concurrent requests; a rolled-back transaction rolls the sequence back with it.
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
  v_ref   text;
  v_tries integer := 0;
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

  loop
    v_ref := v_seq.prefix
          || case when v_seq.include_year then v_year::text || '-' else '' end
          || lpad(v_value::text, v_seq.pad, '0');
    exit when not private.reference_in_use(p_company_id, p_key, v_ref);
    v_value := v_value + 1;
    v_tries := v_tries + 1;
    if v_tries > 10000 then
      raise exception 'Could not find a free % number. Check the numbering settings.', p_key using errcode = 'P0001';
    end if;
  end loop;

  perform set_config('tlt.number_allocation', 'on', true);
  update public.document_sequences
     set next_value = v_value + 1,
         current_year = v_year
   where company_id = p_company_id and key = p_key;
  perform set_config('tlt.number_allocation', 'off', true);
  return v_ref;
end;
$$;

-- Administrators may change the prefix, year and width (Settings → Numbering); they may not move the next number
-- back, which would try to reissue numbers. Allocation itself (including the yearly restart) is exempt.
create or replace function private.document_sequence_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_setting('tlt.number_allocation', true) is distinct from 'on' and new.next_value < old.next_value then
    raise exception 'The next number cannot be lowered (numbers are never reissued). Choose % or higher.', old.next_value
      using errcode = '22023';
  end if;
  if new.key <> old.key or new.company_id <> old.company_id then
    raise exception 'A numbering sequence cannot be moved.' using errcode = '42501';
  end if;
  return new;
end;
$$;
drop trigger if exists document_sequences_guard on public.document_sequences;
create trigger document_sequences_guard before update on public.document_sequences
  for each row execute function private.document_sequence_guard();

-- -----------------------------------------------------------------------------
-- 3. Search keys (upper case, letters and digits only)
-- -----------------------------------------------------------------------------

alter table public.orders add column if not exists order_ref_key text
  generated always as (regexp_replace(upper(order_number), '[^A-Z0-9]', '', 'g')) stored;
alter table public.quotes add column if not exists quote_ref_key text
  generated always as (regexp_replace(upper(quote_number), '[^A-Z0-9]', '', 'g')) stored;
alter table public.delivery_tickets add column if not exists ticket_ref_key text
  generated always as (regexp_replace(upper(ticket_number), '[^A-Z0-9]', '', 'g')) stored;
alter table public.customers add column if not exists customer_ref_key text
  generated always as (regexp_replace(upper(coalesce(customer_number, '')), '[^A-Z0-9]', '', 'g')) stored;
alter table public.billing_handoffs add column if not exists batch_ref_key text
  generated always as (regexp_replace(upper(batch_number), '[^A-Z0-9]', '', 'g')) stored;
alter table public.work_orders add column if not exists work_order_ref_key text
  generated always as (regexp_replace(upper(number), '[^A-Z0-9]', '', 'g')) stored;

create index if not exists orders_ref_key on public.orders (company_id, order_ref_key text_pattern_ops);
create index if not exists quotes_ref_key on public.quotes (company_id, quote_ref_key text_pattern_ops);
create index if not exists delivery_tickets_ref_key on public.delivery_tickets (company_id, ticket_ref_key text_pattern_ops);
create index if not exists customers_ref_key on public.customers (company_id, customer_ref_key text_pattern_ops);
create index if not exists billing_handoffs_ref_key on public.billing_handoffs (company_id, batch_ref_key text_pattern_ops);
create index if not exists work_orders_ref_key on public.work_orders (company_id, work_order_ref_key text_pattern_ops);

revoke all on function private.reference_standard(text), private.reference_legacy_default(text, text, boolean, integer)
  from public, anon;
