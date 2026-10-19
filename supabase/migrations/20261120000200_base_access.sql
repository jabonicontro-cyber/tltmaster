-- =============================================================================
-- Per-person dispatch base access (2026-10-19, master plan B62).
--
-- A company can limit a person to some of its dispatch bases. No rows for a person = every base (the default, so
-- nothing changes for existing people). Owners always see every base. All bases remain one company tenant.
-- 1. public.base_members (company_id, user_id, base_id): set only through public.set_person_bases (users.manage),
--    audited; a person in another company or a base of another company is refused.
-- 2. private.my_bases(): the caller's bases, or null when unrestricted.
-- 3. Restrictive RLS on trucks, trailers, drivers and orders: a restricted person sees and changes only records at
--    their bases (records without a base stay visible). Changing a URL or a filter cannot widen it — the database
--    applies it to every query made as that person.
-- Limitation (stated, not hidden): summary functions that run with elevated rights (dispatch board helpers, Command
-- Center counts) still count the whole company; they show counts, not other bases' records. Tracked in B62.
-- Rollback: supabase/rollbacks/20261120000200_base_access.down.sql
-- =============================================================================

create table public.base_members (
  company_id  uuid not null references public.companies (id),
  user_id     uuid not null references auth.users (id) on delete cascade,
  base_id     uuid not null,
  created_by  uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  primary key (company_id, user_id, base_id),
  foreign key (company_id, base_id) references public.dispatch_bases (company_id, id) on delete cascade
);
alter table public.base_members enable row level security;
create policy base_members_read on public.base_members for select to authenticated
  using (company_id = (select private.current_company_id()) and (user_id = (select auth.uid()) or (select private.has_permission('users.manage'))));
grant select on public.base_members to authenticated;

create or replace function private.my_bases()
 returns uuid[]
 language sql
 stable
 security definer
 set search_path to ''
as $$
  select case
    when private.current_app_role() = 'owner' then null
    else (select array_agg(m.base_id) from public.base_members m
          where m.company_id = private.current_company_id() and m.user_id = auth.uid())
  end;
$$;
revoke all on function private.my_bases() from public, anon;
grant execute on function private.my_bases() to authenticated;

-- True when the caller sees every base (the common case). A boolean the policy checks first, so the planner keeps its
-- normal row estimates (a policy built only from my_bases() made billing views 100x slower through bad estimates).
create or replace function private.base_unrestricted()
 returns boolean
 language sql
 stable
 security definer
 set search_path to ''
as $$
  select private.my_bases() is null;
$$;
revoke all on function private.base_unrestricted() from public, anon;
grant execute on function private.base_unrestricted() to authenticated;

create or replace function public.set_person_bases(p_user uuid, p_bases uuid[])
 returns void
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  v_company uuid := private.require_company();
  v_before uuid[];
begin
  perform private.require_permission('users.manage');
  if not exists (select 1 from public.company_memberships m where m.company_id = v_company and m.user_id = p_user) then
    raise exception 'That person is not in this company.' using errcode = 'P0002';
  end if;
  if exists (select 1 from unnest(coalesce(p_bases, '{}')) b(id)
             where not exists (select 1 from public.dispatch_bases d where d.company_id = v_company and d.id = b.id)) then
    raise exception 'Choose bases of this company.' using errcode = '22023';
  end if;
  select array_agg(base_id order by base_id) into v_before from public.base_members where company_id = v_company and user_id = p_user;
  delete from public.base_members where company_id = v_company and user_id = p_user;
  insert into public.base_members (company_id, user_id, base_id, created_by)
  select distinct v_company, p_user, b.id, auth.uid() from unnest(coalesce(p_bases, '{}')) b(id);
  perform private.log_event('bases.person_access_changed', 'user', p_user,
    case when cardinality(coalesce(p_bases, '{}')) = 0 then 'Access to every dispatch base' else format('Access limited to %s dispatch base(s)', cardinality(p_bases)) end,
    jsonb_build_object('before', coalesce(v_before, '{}'), 'after', coalesce(p_bases, '{}')));
end;
$$;
revoke all on function public.set_person_bases(uuid, uuid[]) from public, anon;
grant execute on function public.set_person_bases(uuid, uuid[]) to authenticated;

-- Restrictive policies: combined with the existing ones, a restricted person only reaches their bases' records.
do $$
declare t text;
begin
  foreach t in array array['trucks', 'trailers', 'drivers', 'orders'] loop
    execute format($p$create policy %I on public.%I as restrictive for all to authenticated
      using ((select private.base_unrestricted()) or base_id is null or array[base_id] <@ (select private.my_bases()))
      with check ((select private.base_unrestricted()) or base_id is null or array[base_id] <@ (select private.my_bases()))$p$,
      t || '_base_access', t);
  end loop;
end $$;

-- Assigning records to bases. Trucks, trailers and drivers are written directly (column grants + their existing
-- policies); orders are written only through functions, so an order's base is set through public.set_order_base.
grant insert (base_id), update (base_id) on public.trucks, public.trailers, public.drivers to authenticated;

create or replace function public.set_order_base(p_order uuid, p_base uuid)
 returns void
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  v_company uuid := private.require_company();
  v_before uuid;
begin
  perform private.require_permission('orders.edit');
  select base_id into v_before from public.orders where id = p_order and company_id = v_company for update;
  if not found then
    raise exception 'Order not found.' using errcode = 'P0002';
  end if;
  if not exists (select 1 from public.dispatch_bases b where b.id = p_base and b.company_id = v_company and b.active) then
    raise exception 'Choose an active base of this company.' using errcode = '22023';
  end if;
  -- A person limited to some bases can only move orders between their own bases.
  if not private.base_unrestricted()
     and not (coalesce(array[v_before] <@ private.my_bases(), v_before is null) and array[p_base] <@ private.my_bases()) then
    raise exception 'You can only work with orders at your dispatch bases.' using errcode = '42501';
  end if;
  if v_before is distinct from p_base then
    update public.orders set base_id = p_base where id = p_order;
    perform private.log_event('orders.base_changed', 'order', p_order, 'Dispatch base changed',
      jsonb_build_object('before', v_before, 'after', p_base));
  end if;
end;
$$;
revoke all on function public.set_order_base(uuid, uuid) from public, anon;
grant execute on function public.set_order_base(uuid, uuid) to authenticated;
