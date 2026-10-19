-- =============================================================================
-- Dispatch bases (2026-10-19, master plan B62; owner directive "Website quality, three-tier demos, multi-location").
--
-- A dispatch base is a place trucks and drivers are dispatched from (a yard or terminal). It is not the company's
-- billing or registered address unless someone configures it as a base. All bases stay inside the one company tenant.
-- 1. public.dispatch_bases: name, short code, address, time zone, location, contact, active, one default per company.
-- 2. Backfill (idempotent): every company gets exactly one default base ("Main base", from its yard location and time
--    zone), and its existing trucks, trailers, drivers and orders are placed at that base. Running again adds nothing.
-- 3. trucks, trailers, drivers and orders carry base_id (same-company foreign keys); new rows without one get the
--    company's default base, so single-base companies work exactly as before.
-- 4. Plan limit, enforced here: active bases ≤ the company's plan (Essential 1, Growth 2, Professional 3, Enterprise 5,
--    Custom no limit). A demo uses its configured tier (companies.demo_plan). A company without a recorded plan keeps
--    one base until Taviron records its plan. Deactivating a base never moves or deletes its records.
-- 5. Read: every member of the company; change: settings.manage. Changes are audited.
-- Not yet (next slice): restricting a person to some bases (per-person base access).
-- Rollback: supabase/rollbacks/20261120000100_dispatch_bases.down.sql
-- =============================================================================

alter table public.companies add column demo_plan text check (demo_plan in ('essential', 'growth', 'professional'));
alter table public.companies add constraint companies_demo_plan check (demo_plan is null or is_demo);

create table public.dispatch_bases (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null default private.current_company_id() references public.companies (id),
  code           text not null check (code ~ '^[A-Z0-9][A-Z0-9-]{0,9}$'),
  name           text not null check (length(btrim(name)) between 1 and 80),
  address_line1  text not null default '' check (length(address_line1) <= 160),
  city           text not null default '' check (length(city) <= 80),
  state          text not null default '' check (length(state) <= 40),
  postal_code    text not null default '' check (length(postal_code) <= 20),
  timezone       text not null default 'America/Chicago',
  latitude       numeric(9, 6) check (latitude between -90 and 90),
  longitude      numeric(9, 6) check (longitude between -180 and 180),
  contact_name   text not null default '' check (length(contact_name) <= 120),
  contact_phone  text not null default '' check (length(contact_phone) <= 40),
  active         boolean not null default true,
  is_default     boolean not null default false,
  created_by     uuid default auth.uid() references auth.users (id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (company_id, id),
  check ((latitude is null) = (longitude is null)),
  check (not is_default or active)
);
create unique index dispatch_bases_code on public.dispatch_bases (company_id, code);
create unique index dispatch_bases_one_default on public.dispatch_bases (company_id) where is_default;

-- The plan's dispatch-base limit (null = no limit).
create or replace function private.base_limit(p_company uuid)
 returns integer
 language sql
 stable
 security definer
 set search_path to ''
as $$
  select case
    when c.is_demo then coalesce((select v.bases from private.platform_plan_versions v where v.plan_key = coalesce(c.demo_plan, 'essential')
                                  order by v.version desc limit 1), 1)
    when l.plan_version_id is not null then (select case when v.plan_key = 'custom' then null else v.bases end from private.platform_plan_versions v where v.id = l.plan_version_id)
    else 1
  end
  from public.companies c left join private.company_lifecycle l on l.company_id = c.id
  where c.id = p_company;
$$;
revoke all on function private.base_limit(uuid) from public, anon;
grant execute on function private.base_limit(uuid) to authenticated;

create or replace function private.dispatch_base_rules()
 returns trigger
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  v_limit integer;
  v_active integer;
begin
  if not exists (select 1 from pg_timezone_names where name = new.timezone) then
    raise exception 'Unknown time zone.' using errcode = '22023';
  end if;
  new.code := upper(btrim(new.code));
  new.updated_at := now();
  if new.active and (tg_op = 'INSERT' or not old.active) then
    v_limit := private.base_limit(new.company_id);
    select count(*) into v_active from public.dispatch_bases where company_id = new.company_id and active and id <> new.id;
    if v_limit is not null and v_active + 1 > v_limit then
      raise exception 'Your plan includes % dispatch base%. Deactivate one, or ask Taviron about a plan with more bases.',
        v_limit, case when v_limit = 1 then '' else 's' end using errcode = 'P0001';
    end if;
  end if;
  if tg_op = 'UPDATE' and old.is_default and not new.active then
    raise exception 'Make another base the default before deactivating this one.' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function private.dispatch_base_rules() from public, anon, authenticated;
create trigger dispatch_bases_rules before insert or update on public.dispatch_bases
  for each row execute function private.dispatch_base_rules();
create trigger dispatch_bases_audit after insert or update or delete on public.dispatch_bases
  for each row execute function private.audit_row_change('dispatch_base');

-- Make a base the company default (the previous default stays active).
create or replace function public.set_default_dispatch_base(p_base uuid)
 returns void
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  v_company uuid := private.require_company();
begin
  perform private.require_permission('settings.manage');
  if not exists (select 1 from public.dispatch_bases where id = p_base and company_id = v_company and active) then
    raise exception 'Choose an active base of this company.' using errcode = 'P0002';
  end if;
  update public.dispatch_bases set is_default = false where company_id = v_company and is_default and id <> p_base;
  update public.dispatch_bases set is_default = true where id = p_base;
end;
$$;
revoke all on function public.set_default_dispatch_base(uuid) from public, anon;
grant execute on function public.set_default_dispatch_base(uuid) to authenticated;

alter table public.dispatch_bases enable row level security;
create policy dispatch_bases_read on public.dispatch_bases for select to authenticated
  using (company_id = (select private.current_company_id()));
create policy dispatch_bases_insert on public.dispatch_bases for insert to authenticated
  with check (company_id = (select private.current_company_id()) and (select private.has_permission('settings.manage')) and not is_default);
create policy dispatch_bases_update on public.dispatch_bases for update to authenticated
  using (company_id = (select private.current_company_id()) and (select private.has_permission('settings.manage')))
  with check (company_id = (select private.current_company_id()) and (select private.has_permission('settings.manage')));
grant select, insert, update on public.dispatch_bases to authenticated;

-- -----------------------------------------------------------------------------
-- Backfill: one default base per company (idempotent).
-- -----------------------------------------------------------------------------
insert into public.dispatch_bases (company_id, code, name, timezone, latitude, longitude, is_default, created_by)
select c.id, 'MAIN', 'Main base', coalesce(s.timezone, 'America/Chicago'), s.yard_latitude, s.yard_longitude, true, null
from public.companies c left join public.company_settings s on s.company_id = c.id
where not exists (select 1 from public.dispatch_bases b where b.company_id = c.id);

alter table public.trucks   add column base_id uuid;
alter table public.trailers add column base_id uuid;
alter table public.drivers  add column base_id uuid;
alter table public.orders   add column base_id uuid;
alter table public.trucks   add constraint trucks_base_fk   foreign key (company_id, base_id) references public.dispatch_bases (company_id, id);
alter table public.trailers add constraint trailers_base_fk foreign key (company_id, base_id) references public.dispatch_bases (company_id, id);
alter table public.drivers  add constraint drivers_base_fk  foreign key (company_id, base_id) references public.dispatch_bases (company_id, id);
alter table public.orders   add constraint orders_base_fk   foreign key (company_id, base_id) references public.dispatch_bases (company_id, id);
create index trucks_base on public.trucks (company_id, base_id);
create index drivers_base on public.drivers (company_id, base_id);
create index orders_base on public.orders (company_id, base_id);

do $$
declare t text;
begin
  -- Existing records go to their company's default base (only where none is set: safe to run again).
  foreach t in array array['trucks', 'trailers', 'drivers', 'orders'] loop
    execute format('alter table public.%I disable trigger user', t);
    execute format('update public.%I x set base_id = b.id from public.dispatch_bases b where b.company_id = x.company_id and b.is_default and x.base_id is null', t);
    execute format('alter table public.%I enable trigger user', t);
  end loop;
end $$;

-- New records without a base get the company's default base.
create or replace function private.default_base()
 returns trigger
 language plpgsql
 security definer
 set search_path to ''
as $$
begin
  if new.base_id is null then
    select b.id into new.base_id from public.dispatch_bases b where b.company_id = new.company_id and b.is_default;
  end if;
  return new;
end;
$$;
revoke all on function private.default_base() from public, anon, authenticated;
create trigger trucks_default_base   before insert on public.trucks   for each row execute function private.default_base();
create trigger trailers_default_base before insert on public.trailers for each row execute function private.default_base();
create trigger drivers_default_base  before insert on public.drivers  for each row execute function private.default_base();
create trigger orders_default_base   before insert on public.orders   for each row execute function private.default_base();

-- A company created later gets its default base too.
create or replace function private.company_default_base()
 returns trigger
 language plpgsql
 security definer
 set search_path to ''
as $$
begin
  insert into public.dispatch_bases (company_id, code, name, is_default, created_by)
  values (new.id, 'MAIN', 'Main base', true, null)
  on conflict do nothing;
  return null;
end;
$$;
revoke all on function private.company_default_base() from public, anon, authenticated;
create trigger companies_default_base after insert on public.companies for each row execute function private.company_default_base();

-- Location-aware reporting: per base and in total, each record counted once at the one base it belongs to.
create or replace function public.dispatch_base_summary(p_from date, p_to date)
 returns jsonb
 language sql
 stable
 security invoker
 set search_path to ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', b.id, 'code', b.code, 'name', b.name, 'active', b.active, 'is_default', b.is_default,
    'trucks', (select count(*) from public.trucks t where t.base_id = b.id and t.active),
    'trucks_available', (select count(*) from public.trucks t where t.base_id = b.id and t.active and t.service_status = 'in_service'),
    'drivers', (select count(*) from public.drivers d where d.base_id = b.id and d.active),
    'orders', (select count(*) from public.orders o where o.base_id = b.id and o.order_date between p_from and p_to and o.status <> 'canceled'),
    'loads', (select count(*) from public.order_loads l join public.orders o on o.id = l.order_id where o.base_id = b.id and l.load_date between p_from and p_to and l.status <> 'canceled'),
    'ordered_cents', (select coalesce(sum(o.total_cents), 0) from public.orders o where o.base_id = b.id and o.order_date between p_from and p_to and o.status <> 'canceled'))
    order by b.is_default desc, b.code), '[]')
  from public.dispatch_bases b;
$$;
revoke all on function public.dispatch_base_summary(date, date) from public, anon;
grant execute on function public.dispatch_base_summary(date, date) to authenticated;
