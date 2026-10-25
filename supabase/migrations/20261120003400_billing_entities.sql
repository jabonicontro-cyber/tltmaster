-- =============================================================================
-- Billing entities (cost centers) within one company (owner 2026-10-25, master plan B89).
--
-- Example: Top Line Stone & Sand bills the materials and Top Line Trucking bills the delivery on the same order. The
-- work stays one order, one dispatch, one set of tickets; only billing is split. Each entity has its own name, remit-to
-- address and invoice prefix, and (20261120003500) its own QuickBooks company.
--
--   billing_entities       the businesses that send invoices; one is the default. A company without entities bills
--                          as before (everything under the company).
--   billing_entity_rules   which entity bills each charge type (material, hauling, service, surcharge, discount,
--                          other); a type without a rule goes to the default entity.
--
-- At handoff each line of the frozen snapshot is stamped with its entity (trigger on billing_handoff_orders), so the
-- invoices always match what was handed off even if the rules change later.
-- Changes need billing.manage. Reversible: supabase/rollbacks/20261120003400_billing_entities.down.sql
-- =============================================================================

create table public.billing_entities (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null default private.current_company_id() references public.companies (id),
  name            text not null check (length(trim(name)) between 1 and 120),
  legal_name      text not null default '' check (length(legal_name) <= 200),
  address_line1   text not null default '' check (length(address_line1) <= 200),
  address_line2   text not null default '' check (length(address_line2) <= 200),
  city            text not null default '' check (length(city) <= 100),
  region          text not null default '' check (length(region) <= 50),
  postal_code     text not null default '' check (length(postal_code) <= 20),
  phone           text not null default '' check (length(phone) <= 40),
  email           text not null default '' check (length(email) <= 200),
  invoice_prefix  text not null default '' check (invoice_prefix ~ '^[A-Z0-9-]{0,6}$'),
  is_default      boolean not null default false,
  active          boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (company_id, id),
  unique (company_id, name)
);
create unique index billing_entities_one_default on public.billing_entities (company_id) where is_default;

create table public.billing_entity_rules (
  company_id   uuid not null references public.companies (id),
  charge_kind  text not null check (charge_kind in ('material', 'hauling', 'service', 'surcharge', 'discount', 'other')),
  entity_id    uuid not null,
  primary key (company_id, charge_kind),
  foreign key (company_id, entity_id) references public.billing_entities (company_id, id) on delete cascade
);

alter table public.billing_entities enable row level security;
alter table public.billing_entity_rules enable row level security;
revoke all on public.billing_entities, public.billing_entity_rules from anon, authenticated;
grant select on public.billing_entities, public.billing_entity_rules to authenticated;
create policy billing_entities_read on public.billing_entities for select to authenticated
  using (company_id = (select private.current_company_id()) and ((select private.has_permission('billing.view')) or (select private.has_permission('orders.view'))));
create policy billing_entity_rules_read on public.billing_entity_rules for select to authenticated
  using (company_id = (select private.current_company_id()) and ((select private.has_permission('billing.view')) or (select private.has_permission('orders.view'))));

-- Create or update an entity. p: {name, legal_name, address_line1, address_line2, city, region, postal_code, phone,
-- email, invoice_prefix, is_default, active}. The first entity becomes the default; making one default unsets the other.
create or replace function public.billing_entity_save(p_id uuid, p jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v_id uuid := p_id;
  v_default boolean := coalesce((p ->> 'is_default')::boolean, false)
                       or not exists (select 1 from public.billing_entities e where e.company_id = v_company and e.id is distinct from p_id);
begin
  perform private.require_permission('billing.manage');
  if coalesce(trim(p ->> 'name'), '') = '' then raise exception 'Give the business a name.' using errcode = '22023'; end if;
  if upper(coalesce(p ->> 'invoice_prefix', '')) !~ '^[A-Z0-9-]{0,6}$' then
    raise exception 'The invoice prefix is up to 6 letters, digits or dashes.' using errcode = '22023';
  end if;
  if v_default then update public.billing_entities set is_default = false where company_id = v_company and is_default and id is distinct from v_id; end if;
  if v_id is null then
    insert into public.billing_entities (company_id, name, legal_name, address_line1, address_line2, city, region, postal_code, phone, email, invoice_prefix, is_default, active)
    values (v_company, trim(p ->> 'name'), coalesce(p ->> 'legal_name', ''), coalesce(p ->> 'address_line1', ''), coalesce(p ->> 'address_line2', ''),
            coalesce(p ->> 'city', ''), coalesce(p ->> 'region', ''), coalesce(p ->> 'postal_code', ''), coalesce(p ->> 'phone', ''),
            coalesce(p ->> 'email', ''), upper(coalesce(p ->> 'invoice_prefix', '')), v_default, coalesce((p ->> 'active')::boolean, true))
    returning id into v_id;
  else
    update public.billing_entities
       set name = trim(p ->> 'name'), legal_name = coalesce(p ->> 'legal_name', ''), address_line1 = coalesce(p ->> 'address_line1', ''),
           address_line2 = coalesce(p ->> 'address_line2', ''), city = coalesce(p ->> 'city', ''), region = coalesce(p ->> 'region', ''),
           postal_code = coalesce(p ->> 'postal_code', ''), phone = coalesce(p ->> 'phone', ''), email = coalesce(p ->> 'email', ''),
           invoice_prefix = upper(coalesce(p ->> 'invoice_prefix', '')), is_default = v_default or is_default,
           active = coalesce((p ->> 'active')::boolean, active), updated_at = now()
     where id = v_id and company_id = v_company;
    if not found then raise exception 'Business not found.' using errcode = 'P0002'; end if;
  end if;
  if exists (select 1 from public.billing_entities e where e.id = v_id and e.is_default and not e.active) then
    raise exception 'The default business must stay active.' using errcode = '22023';
  end if;
  return v_id;
end;
$$;
revoke all on function public.billing_entity_save(uuid, jsonb) from public, anon;
grant execute on function public.billing_entity_save(uuid, jsonb) to authenticated;

-- Which business bills each charge type. p: {"material": "<entity id>", "hauling": "<entity id>", ...}; a type left out
-- goes to the default business.
create or replace function public.billing_entity_rules_save(p jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v_kind text;
  v_entity uuid;
begin
  perform private.require_permission('billing.manage');
  delete from public.billing_entity_rules where company_id = v_company;
  for v_kind, v_entity in select key, nullif(value #>> '{}', '')::uuid from jsonb_each(coalesce(p, '{}'::jsonb)) loop
    if v_entity is null then continue; end if;
    if v_kind not in ('material', 'hauling', 'service', 'surcharge', 'discount', 'other') then raise exception 'Unknown charge type.' using errcode = '22023'; end if;
    if not exists (select 1 from public.billing_entities e where e.id = v_entity and e.company_id = v_company and e.active) then
      raise exception 'Choose an active business.' using errcode = '22023';
    end if;
    insert into public.billing_entity_rules (company_id, charge_kind, entity_id) values (v_company, v_kind, v_entity);
  end loop;
end;
$$;
revoke all on function public.billing_entity_rules_save(jsonb) from public, anon;
grant execute on function public.billing_entity_rules_save(jsonb) to authenticated;

-- The business that bills a charge type (internal): its rule, else the default business; null without businesses.
create or replace function private.billing_entity_for(p_company uuid, p_kind text)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select r.entity_id from public.billing_entity_rules r join public.billing_entities e on e.id = r.entity_id and e.active
      where r.company_id = p_company and r.charge_kind = p_kind),
    (select e.id from public.billing_entities e where e.company_id = p_company and e.is_default));
$$;
revoke all on function private.billing_entity_for(uuid, text) from public, anon, authenticated;

-- Stamp each snapshot line with its business when an order is handed off (only when the company has businesses).
create or replace function private.billing_handoff_stamp_entities()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.billing_entities e where e.company_id = new.company_id) then return new; end if;
  new.snapshot := jsonb_set(new.snapshot, '{lines}', coalesce((
    select jsonb_agg(l || jsonb_build_object('billing_entity_id', b.id, 'billing_entity_name', b.name) order by (l ->> 'line_no')::integer)
    from jsonb_array_elements(new.snapshot -> 'lines') l
    left join public.billing_entities b on b.id = private.billing_entity_for(new.company_id, l ->> 'kind')), '[]'::jsonb));
  return new;
end;
$$;
revoke all on function private.billing_handoff_stamp_entities() from public, anon, authenticated;
create trigger billing_handoff_orders_stamp_entities before insert on public.billing_handoff_orders
  for each row execute function private.billing_handoff_stamp_entities();
