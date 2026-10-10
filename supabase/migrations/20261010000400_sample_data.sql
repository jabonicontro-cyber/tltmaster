-- =============================================================================
-- Sample-data removal. Development fixtures are flagged is_sample = true and
-- shown with a "SAMPLE" badge. The owner can remove them before go-live.
-- =============================================================================

-- Allow append-only / locked rows to be removed only while purging sample
-- quotes inside public.remove_sample_data().
create or replace function private.prevent_modification()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE'
     and current_setting('tlt.sample_purge', true) = 'on'
     and tg_table_name in ('quote_status_events', 'email_deliveries', 'documents') then
    return old;
  end if;
  raise exception '% rows are append-only and cannot be changed or deleted.', tg_table_name
    using errcode = '42501';
end;
$$;

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

create or replace function private.guard_locked_lines()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_version_id uuid := coalesce(new.quote_version_id, old.quote_version_id);
begin
  if tg_op = 'DELETE' and current_setting('tlt.sample_purge', true) = 'on' then
    return old;
  end if;
  if exists (select 1 from public.quote_versions v where v.id = v_version_id and v.locked_at is not null) then
    raise exception 'Lines of an issued quote version cannot be changed. Create a revision instead.'
      using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and new.quote_version_id <> old.quote_version_id then
    raise exception 'Quote lines cannot be moved between versions.' using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create or replace function public.sample_data_counts()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'customers', (select count(*) from public.customers where is_sample),
    'materials', (select count(*) from public.materials where is_sample),
    'charge_items', (select count(*) from public.charge_items where is_sample),
    'price_lists', (select count(*) from public.price_lists where is_sample),
    'quotes', (select count(*) from public.quotes where is_sample)
  )
  where private.current_app_role() is not null
$$;

create or replace function public.remove_sample_data()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_quotes integer;
  v_customers integer;
  v_customers_kept integer;
  v_materials integer;
  v_materials_kept integer;
  v_charges integer;
  v_charges_kept integer;
  v_lists integer;
begin
  perform private.require_permission('settings.manage');

  perform set_config('tlt.sample_purge', 'on', true);

  -- Quotes on sample customers are themselves sample data.
  update public.quotes q set is_sample = true
  from public.customers c
  where c.id = q.customer_id and c.is_sample and not q.is_sample;

  update public.quotes set current_version_id = null, accepted_version_id = null where is_sample;
  delete from public.quotes where is_sample;
  get diagnostics v_quotes = row_count;

  delete from public.customers c
  where c.is_sample and not exists (select 1 from public.quotes q where q.customer_id = c.id);
  get diagnostics v_customers = row_count;
  update public.customers set active = false where is_sample;
  get diagnostics v_customers_kept = row_count;

  delete from public.materials m
  where m.is_sample and not exists (select 1 from public.quote_lines l where l.material_id = m.id);
  get diagnostics v_materials = row_count;
  update public.materials set active = false where is_sample;
  get diagnostics v_materials_kept = row_count;

  delete from public.charge_items ci
  where ci.is_sample and not exists (select 1 from public.quote_lines l where l.charge_item_id = ci.id);
  get diagnostics v_charges = row_count;
  update public.charge_items set active = false where is_sample;
  get diagnostics v_charges_kept = row_count;

  update public.customers set price_list_id = null
  where price_list_id in (select id from public.price_lists where is_sample);
  delete from public.price_lists where is_sample;
  get diagnostics v_lists = row_count;

  perform set_config('tlt.sample_purge', 'off', true);

  perform private.log_event('sample_data.removed', 'system', null,
    format('Sample data removed: %s quotes, %s customers, %s materials, %s charges, %s price lists',
           v_quotes, v_customers, v_materials, v_charges, v_lists),
    jsonb_build_object('quotes', v_quotes, 'customers', v_customers, 'materials', v_materials,
                       'charge_items', v_charges, 'price_lists', v_lists,
                       'deactivated_in_use', jsonb_build_object(
                         'customers', v_customers_kept, 'materials', v_materials_kept,
                         'charge_items', v_charges_kept)));

  return jsonb_build_object('quotes', v_quotes, 'customers', v_customers, 'materials', v_materials,
                            'charge_items', v_charges, 'price_lists', v_lists,
                            'deactivated_in_use', v_customers_kept + v_materials_kept + v_charges_kept);
end;
$$;

revoke execute on function public.sample_data_counts() from public, anon;
revoke execute on function public.remove_sample_data() from public, anon;
grant execute on function public.sample_data_counts() to authenticated;
grant execute on function public.remove_sample_data() to authenticated;
revoke execute on all functions in schema private from public, anon;
