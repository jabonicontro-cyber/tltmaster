-- =============================================================================
-- Demo duplicate cleanup, the finding step (owner decision 2026-11-17; master plan §12 DP2). A race while a prospect
-- demo was first filled (fixed since by the refresh lock) left exact copies of some sample customers and people a few
-- seconds apart. Refresh demo data now removes them, keeping the older row (src/server/demo/duplicates.ts).
--
-- public.demo_duplicate_samples(customer names, people names) only FINDS them; it changes nothing (stable). It answers
-- only the owner of the current company when that company is a demo (private.demo_owner_company(); refused with 42501
-- for a real company), and only for rows whose name is one of the demo's sample names the app passes in:
--   * a customer is a duplicate when an older customer of the same demo has the same name and every other field equal
--     (ids, numbers and times aside); its job sites must each be an exact copy of a site of the older customer;
--   * a person (employees) is a duplicate on the same rule.
-- A duplicate is offered for removal only when nothing in the database points at it (every foreign key is checked,
-- whatever the table), nor at its copied sites; one that something points at is returned under "kept" and left alone
-- (nothing is merged). Removal itself is done by the app, demo companies only, for exactly the ids returned here.
-- Additive: one function and two private helpers; no table, column or row changes.
-- Rollback: supabase/rollbacks/20261120024510_demo_duplicate_samples.down.sql
-- =============================================================================

-- Does any row of any table point at this row (through a foreign key on its id)? p_skip names one table to leave out
-- (a customer's own job sites, which are checked on their own).
create or replace function private.demo_row_referenced(p_table regclass, p_id uuid, p_skip regclass default null)
returns boolean
language plpgsql
stable
set search_path = ''
as $$
declare
  r record;
  v_found boolean;
begin
  for r in
    select c.conrelid::regclass as src, a.attname as col
      from pg_constraint c
      join pg_attribute t on t.attrelid = c.confrelid and t.attname = 'id'
      cross join lateral unnest(c.confkey, c.conkey) as k(target_col, source_col)
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.source_col
     where c.contype = 'f' and c.confrelid = p_table and k.target_col = t.attnum
       and (p_skip is null or c.conrelid <> p_skip)
  loop
    execute format('select exists (select 1 from %s where %I = $1)', r.src, r.col) into v_found using p_id;
    if v_found then
      return true;
    end if;
  end loop;
  return false;
end;
$$;
revoke all on function private.demo_row_referenced(regclass, uuid, regclass) from public, anon, authenticated;

-- A row as JSON without the fields that differ between two copies made a few seconds apart.
create or replace function private.demo_row_shape(p_row jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select p_row - array['id', 'customer_id', 'customer_number', 'customer_ref_key', 'created_at', 'updated_at', 'created_by',
                       'updated_by', 'located_at']
$$;
revoke all on function private.demo_row_shape(jsonb) from public, anon, authenticated;

create or replace function public.demo_duplicate_samples(p_customers text[], p_people text[])
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.demo_owner_company();
  v_customers jsonb := '[]'::jsonb;
  v_sites jsonb := '[]'::jsonb;
  v_people jsonb := '[]'::jsonb;
  v_kept jsonb := '[]'::jsonb;
  d record;
  v_site_ids uuid[];
  v_ok boolean;
begin
  if v_company is null then
    raise exception 'Only the owner of a demo company can clean up its sample data.' using errcode = '42501';
  end if;

  -- Customers: each copy of an older customer with the same name and fields.
  for d in
    select c.id, c.name, k.id as keep_id
      from public.customers c
      join lateral (
        select o.id from public.customers o
         where o.company_id = c.company_id and o.name = c.name and o.id <> c.id
           and (o.created_at, o.id) < (c.created_at, c.id)
           and private.demo_row_shape(to_jsonb(o)) = private.demo_row_shape(to_jsonb(c))
         order by o.created_at, o.id limit 1) k on true
     where c.company_id = v_company and c.name = any (coalesce(p_customers, '{}'))
     order by c.name, c.created_at, c.id
  loop
    -- Its job sites must each copy a site of the kept customer and be unused.
    select coalesce(array_agg(s.id), '{}'),
           coalesce(bool_and(
             exists (select 1 from public.customer_sites o where o.company_id = v_company and o.customer_id = d.keep_id
                        and private.demo_row_shape(to_jsonb(o)) = private.demo_row_shape(to_jsonb(s)))
             and not private.demo_row_referenced('public.customer_sites'::regclass, s.id)), true)
      into v_site_ids, v_ok
      from public.customer_sites s where s.company_id = v_company and s.customer_id = d.id;
    if v_ok and not private.demo_row_referenced('public.customers'::regclass, d.id, 'public.customer_sites'::regclass) then
      v_customers := v_customers || jsonb_build_array(d.id);
      v_sites := v_sites || to_jsonb(v_site_ids);
    else
      v_kept := v_kept || jsonb_build_array(jsonb_build_object('kind', 'customer', 'name', d.name, 'id', d.id));
    end if;
  end loop;

  -- People: each copy of an older person with the same name and fields.
  for d in
    select e.id, e.full_name as name
      from public.employees e
     where e.company_id = v_company and e.full_name = any (coalesce(p_people, '{}'))
       and exists (select 1 from public.employees o
                    where o.company_id = e.company_id and o.full_name = e.full_name and o.id <> e.id
                      and (o.created_at, o.id) < (e.created_at, e.id)
                      and private.demo_row_shape(to_jsonb(o)) = private.demo_row_shape(to_jsonb(e)))
     order by e.full_name, e.created_at, e.id
  loop
    if private.demo_row_referenced('public.employees'::regclass, d.id) then
      v_kept := v_kept || jsonb_build_array(jsonb_build_object('kind', 'person', 'name', d.name, 'id', d.id));
    else
      v_people := v_people || jsonb_build_array(d.id);
    end if;
  end loop;

  return jsonb_build_object('customers', v_customers, 'sites', v_sites, 'people', v_people, 'kept', v_kept);
end;
$$;
revoke all on function public.demo_duplicate_samples(text[], text[]) from public, anon;
grant execute on function public.demo_duplicate_samples(text[], text[]) to authenticated;
