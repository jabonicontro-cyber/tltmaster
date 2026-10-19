-- =============================================================================
-- Company CRM, slice 1 (2026-10-19, master plan B59; owner directive "Gap analysis and continuation" §3).
--
-- Each company's own customers and prospects (never Taviron's platform leads, which stay in private.leads):
-- 1. customers gain a relationship (prospect / customer), an account owner (a member of the same company) and tags.
--    A prospect becomes a customer when an opportunity is won or when its first order is created — the same record, so
--    nothing is duplicated.
-- 2. customer_activities: calls, meetings, emails (logged by hand — nothing is sent), notes and visits; append-only.
-- 3. customer_tasks: follow-ups with a due date and an assignee in the company; done / canceled are recorded.
-- 4. crm_opportunities: a sales pipeline with fixed stages (new → contacted → qualified → quoting → negotiation → won /
--    lost), value, probability, expected close, next action, follow-up date, an optional quote, and a required lost
--    reason. Stage changes are kept in crm_opportunity_events.
-- 5. public.customer_history(id) and public.customer_duplicates(name, email, phone): read helpers that run with the
--    caller's rights (SECURITY INVOKER), so RLS decides what they can see.
-- Permissions: customers.view to read, customers.edit to write — the existing customer permissions. Company isolation:
-- company_id defaults to the current company, RLS checks it, and composite foreign keys keep every reference inside
-- the company.
-- Rollback: supabase/rollbacks/20261119000100_customer_crm.down.sql
-- =============================================================================

alter table public.customers
  add column relationship text not null default 'customer' check (relationship in ('prospect', 'customer')),
  add column account_owner_id uuid references auth.users (id) on delete set null,
  add column tags text[] not null default '{}' check (cardinality(tags) <= 20);

-- Members of the company only (account owners, task assignees, opportunity owners).
create or replace function private.is_company_member(p_company uuid, p_user uuid)
 returns boolean
 language sql
 stable
 security definer
 set search_path to ''
as $$
  select p_user is null or exists (select 1 from public.company_memberships m where m.company_id = p_company and m.user_id = p_user and m.active);
$$;
revoke all on function private.is_company_member(uuid, uuid) from public, anon;
grant execute on function private.is_company_member(uuid, uuid) to authenticated;

create or replace function private.guard_customer_crm_fields()
 returns trigger
 language plpgsql
 set search_path to ''
as $$
begin
  if not private.is_company_member(new.company_id, new.account_owner_id) then
    raise exception 'The account owner must be someone in this company.' using errcode = '23514';
  end if;
  new.tags := coalesce((select array_agg(distinct t order by t) from unnest(new.tags) x(t0), lateral (select left(btrim(t0), 40) as t) y where t <> ''), '{}');
  return new;
end;
$$;
create trigger customers_crm_fields before insert or update of account_owner_id, tags on public.customers
  for each row execute function private.guard_customer_crm_fields();

-- -----------------------------------------------------------------------------
create table public.customer_activities (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null default private.current_company_id() references public.companies (id),
  customer_id  uuid not null,
  contact_id   uuid,
  kind         text not null check (kind in ('call', 'meeting', 'email', 'note', 'visit')),
  occurred_at  timestamptz not null default now(),
  subject      text not null check (length(btrim(subject)) between 1 and 200),
  body         text not null default '' check (length(body) <= 4000),
  created_by   uuid not null default auth.uid() references auth.users (id),
  created_at   timestamptz not null default now(),
  foreign key (company_id, customer_id) references public.customers (company_id, id) on delete cascade,
  foreign key (company_id, contact_id) references public.customer_contacts (company_id, id),
  check (occurred_at <= created_at + interval '1 day')
);
create index customer_activities_customer on public.customer_activities (company_id, customer_id, occurred_at desc);

create table public.crm_opportunities (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null default private.current_company_id() references public.companies (id),
  customer_id       uuid not null,
  title             text not null check (length(btrim(title)) between 1 and 200),
  stage             text not null default 'new' check (stage in ('new', 'contacted', 'qualified', 'quoting', 'negotiation', 'won', 'lost')),
  value_cents       bigint check (value_cents is null or value_cents between 0 and 100000000000),
  probability       integer check (probability is null or probability between 0 and 100),
  expected_close_on date,
  owner_id          uuid references auth.users (id) on delete set null,
  next_action       text not null default '' check (length(next_action) <= 300),
  follow_up_on      date,
  quote_id          uuid,
  lost_reason       text not null default '' check (length(lost_reason) <= 500),
  closed_at         timestamptz,
  created_by        uuid not null default auth.uid() references auth.users (id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (company_id, id),
  foreign key (company_id, customer_id) references public.customers (company_id, id) on delete cascade,
  foreign key (company_id, quote_id) references public.quotes (company_id, id),
  check (stage <> 'lost' or length(btrim(lost_reason)) > 0),
  check ((stage in ('won', 'lost')) = (closed_at is not null))
);
create index crm_opportunities_company on public.crm_opportunities (company_id, stage, follow_up_on);
create index crm_opportunities_customer on public.crm_opportunities (company_id, customer_id);

create table public.crm_opportunity_events (
  id              bigint generated always as identity primary key,
  company_id      uuid not null references public.companies (id),
  opportunity_id  uuid not null,
  from_stage      text,
  to_stage        text not null,
  actor_id        uuid,
  occurred_at     timestamptz not null default clock_timestamp(),
  foreign key (company_id, opportunity_id) references public.crm_opportunities (company_id, id) on delete cascade
);
create index crm_opportunity_events_opp on public.crm_opportunity_events (company_id, opportunity_id, occurred_at);

create table public.customer_tasks (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null default private.current_company_id() references public.companies (id),
  customer_id     uuid not null,
  opportunity_id  uuid,
  title           text not null check (length(btrim(title)) between 1 and 200),
  notes           text not null default '' check (length(notes) <= 2000),
  due_on          date,
  assigned_to     uuid references auth.users (id) on delete set null,
  status          text not null default 'open' check (status in ('open', 'done', 'canceled')),
  completed_at    timestamptz,
  completed_by    uuid references auth.users (id) on delete set null,
  created_by      uuid not null default auth.uid() references auth.users (id),
  created_at      timestamptz not null default now(),
  foreign key (company_id, customer_id) references public.customers (company_id, id) on delete cascade,
  foreign key (company_id, opportunity_id) references public.crm_opportunities (company_id, id) on delete cascade,
  check ((status = 'open') = (completed_at is null))
);
create index customer_tasks_open on public.customer_tasks (company_id, status, due_on);
create index customer_tasks_customer on public.customer_tasks (company_id, customer_id);

-- Opportunities: owner in the company, closing timestamps, stage history, and a won prospect becomes a customer.
create or replace function private.crm_opportunity_rules()
 returns trigger
 language plpgsql
 security definer
 set search_path to ''
as $$
begin
  if not private.is_company_member(new.company_id, new.owner_id) then
    raise exception 'The opportunity owner must be someone in this company.' using errcode = '23514';
  end if;
  if tg_op = 'UPDATE' and old.stage in ('won', 'lost') and new.stage not in ('won', 'lost') then
    new.closed_at := null;                -- reopened
  elsif new.stage in ('won', 'lost') and (tg_op = 'INSERT' or old.stage is distinct from new.stage) then
    new.closed_at := now();
  end if;
  if new.stage <> 'lost' then new.lost_reason := ''; end if;
  new.updated_at := now();
  return new;
end;
$$;
revoke all on function private.crm_opportunity_rules() from public, anon, authenticated;
create trigger crm_opportunities_rules before insert or update on public.crm_opportunities
  for each row execute function private.crm_opportunity_rules();

create or replace function private.crm_opportunity_after()
 returns trigger
 language plpgsql
 security definer
 set search_path to ''
as $$
begin
  if tg_op = 'INSERT' or old.stage is distinct from new.stage then
    insert into public.crm_opportunity_events (company_id, opportunity_id, from_stage, to_stage, actor_id)
    values (new.company_id, new.id, case when tg_op = 'UPDATE' then old.stage end, new.stage, auth.uid());
  end if;
  if new.stage = 'won' then
    update public.customers set relationship = 'customer'
     where company_id = new.company_id and id = new.customer_id and relationship = 'prospect';
  end if;
  return null;
end;
$$;
revoke all on function private.crm_opportunity_after() from public, anon, authenticated;
create trigger crm_opportunities_after after insert or update on public.crm_opportunities
  for each row execute function private.crm_opportunity_after();

-- A prospect with its first order is a customer.
create or replace function private.crm_customer_on_order()
 returns trigger
 language plpgsql
 security definer
 set search_path to ''
as $$
begin
  update public.customers set relationship = 'customer'
   where company_id = new.company_id and id = new.customer_id and relationship = 'prospect';
  return null;
end;
$$;
revoke all on function private.crm_customer_on_order() from public, anon, authenticated;
create trigger orders_crm_customer after insert on public.orders
  for each row execute function private.crm_customer_on_order();

-- Tasks: assignee in the company; who completed it and when.
create or replace function private.customer_task_rules()
 returns trigger
 language plpgsql
 set search_path to ''
as $$
begin
  if not private.is_company_member(new.company_id, new.assigned_to) then
    raise exception 'Assign the task to someone in this company.' using errcode = '23514';
  end if;
  if new.status = 'open' then
    new.completed_at := null; new.completed_by := null;
  elsif tg_op = 'INSERT' or old.status = 'open' then
    new.completed_at := now(); new.completed_by := auth.uid();
  end if;
  return new;
end;
$$;
create trigger customer_tasks_rules before insert or update on public.customer_tasks
  for each row execute function private.customer_task_rules();

-- Audit (same audit_events log as customers).
create trigger customer_activities_audit after insert on public.customer_activities
  for each row execute function private.audit_row_change('customer_activity');
create trigger crm_opportunities_audit after insert or update or delete on public.crm_opportunities
  for each row execute function private.audit_row_change('crm_opportunity');
create trigger customer_tasks_audit after insert or update or delete on public.customer_tasks
  for each row execute function private.audit_row_change('customer_task');

-- RLS: same company, customers.view to read, customers.edit to write. Activities and stage history are append-only.
alter table public.customer_activities enable row level security;
alter table public.crm_opportunities enable row level security;
alter table public.crm_opportunity_events enable row level security;
alter table public.customer_tasks enable row level security;

create policy customer_activities_read on public.customer_activities for select to authenticated
  using (company_id = (select private.current_company_id()) and (select private.has_permission('customers.view')));
create policy customer_activities_insert on public.customer_activities for insert to authenticated
  with check (company_id = (select private.current_company_id()) and (select private.has_permission('customers.edit')) and created_by = (select auth.uid()));

create policy crm_opportunities_read on public.crm_opportunities for select to authenticated
  using (company_id = (select private.current_company_id()) and (select private.has_permission('customers.view')));
create policy crm_opportunities_insert on public.crm_opportunities for insert to authenticated
  with check (company_id = (select private.current_company_id()) and (select private.has_permission('customers.edit')) and created_by = (select auth.uid()));
create policy crm_opportunities_update on public.crm_opportunities for update to authenticated
  using (company_id = (select private.current_company_id()) and (select private.has_permission('customers.edit')))
  with check (company_id = (select private.current_company_id()) and (select private.has_permission('customers.edit')));

create policy crm_opportunity_events_read on public.crm_opportunity_events for select to authenticated
  using (company_id = (select private.current_company_id()) and (select private.has_permission('customers.view')));

create policy customer_tasks_read on public.customer_tasks for select to authenticated
  using (company_id = (select private.current_company_id()) and (select private.has_permission('customers.view')));
create policy customer_tasks_insert on public.customer_tasks for insert to authenticated
  with check (company_id = (select private.current_company_id()) and (select private.has_permission('customers.edit')) and created_by = (select auth.uid()));
create policy customer_tasks_update on public.customer_tasks for update to authenticated
  using (company_id = (select private.current_company_id()) and (select private.has_permission('customers.edit')))
  with check (company_id = (select private.current_company_id()) and (select private.has_permission('customers.edit')));

grant select, insert on public.customer_activities to authenticated;
grant select, insert, update on public.crm_opportunities to authenticated;
grant select on public.crm_opportunity_events to authenticated;
grant select, insert, update on public.customer_tasks to authenticated;

-- -----------------------------------------------------------------------------
-- Read helpers (caller's rights: RLS of orders, loads and tickets applies).
-- -----------------------------------------------------------------------------

-- A customer's history from the operational records: orders, delivered tickets, quotes, last order, and whether the
-- account has gone quiet (no new order for 90 days after having ordered before — a stated, fixed rule).
create or replace function public.customer_history(p_customer uuid)
 returns jsonb
 language sql
 stable
 security invoker
 set search_path to ''
as $$
  with o as (
    select id, order_number, status, order_date, total_cents from public.orders where customer_id = p_customer
  ), t as (
    select d.unit_code, d.quantity, d.delivered_at from public.delivery_tickets d
    where d.order_id in (select id from o) and d.status = 'accepted'
  ), q as (
    select status from public.quotes where customer_id = p_customer
  )
  select jsonb_build_object(
    'orders', (select count(*) from o where status <> 'canceled'),
    'open_orders', (select count(*) from o where status not in ('completed', 'canceled')),
    'first_order_on', (select min(order_date) from o where status <> 'canceled'),
    'last_order_on', (select max(order_date) from o where status <> 'canceled'),
    'ordered_cents_365d', (select coalesce(sum(total_cents), 0) from o where status <> 'canceled' and order_date > current_date - 365),
    'accepted_tickets', (select count(*) from t),
    'delivered_365d', (select coalesce(jsonb_object_agg(unit_code, qty), '{}') from (select unit_code, sum(quantity) qty from t where delivered_at > now() - interval '365 days' group by unit_code) x),
    'quotes', jsonb_build_object(
      'open', (select count(*) from q where status in ('draft', 'sent')),
      'accepted', (select count(*) from q where status = 'accepted'),
      'decided', (select count(*) from q where status in ('accepted', 'declined', 'expired'))),
    'recent_orders', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'order_number', order_number, 'status', status, 'order_date', order_date, 'total_cents', total_cents) order by order_date desc, order_number desc), '[]')
                      from (select * from o order by order_date desc, order_number desc limit 10) r),
    'quiet', (select max(order_date) < current_date - 90 from o where status <> 'canceled')
  );
$$;
revoke all on function public.customer_history(uuid) from public, anon;
grant execute on function public.customer_history(uuid) to authenticated;

-- Possible duplicates of a new customer: same name (ignoring case, punctuation and company suffixes), same email or the
-- same phone digits. Caller's rights.
create or replace function public.customer_duplicates(p_name text, p_email text, p_phone text)
 returns table (id uuid, customer_number text, name text, relationship text, active boolean, matched_on text)
 language sql
 stable
 security invoker
 set search_path to ''
as $$
  with k as (
    select regexp_replace(regexp_replace(lower(coalesce(p_name, '')), '\m(inc|llc|ltd|co|corp|company|the)\M', '', 'g'), '[^a-z0-9]', '', 'g') as n,
           lower(btrim(coalesce(p_email, ''))) as e,
           regexp_replace(coalesce(p_phone, ''), '\D', '', 'g') as p
  )
  select c.id, c.customer_number, c.name, c.relationship, c.active,
         case when k.n <> '' and regexp_replace(regexp_replace(lower(c.name), '\m(inc|llc|ltd|co|corp|company|the)\M', '', 'g'), '[^a-z0-9]', '', 'g') = k.n then 'name'
              when k.e <> '' and lower(c.email) = k.e then 'email'
              else 'phone' end
  from public.customers c, k
  where (k.n <> '' and regexp_replace(regexp_replace(lower(c.name), '\m(inc|llc|ltd|co|corp|company|the)\M', '', 'g'), '[^a-z0-9]', '', 'g') = k.n)
     or (k.e <> '' and lower(c.email) = k.e)
     or (length(k.p) >= 7 and right(regexp_replace(c.phone, '\D', '', 'g'), 10) = right(k.p, 10))
  order by c.active desc, c.name
  limit 10;
$$;
revoke all on function public.customer_duplicates(text, text, text) from public, anon;
grant execute on function public.customer_duplicates(text, text, text) to authenticated;
