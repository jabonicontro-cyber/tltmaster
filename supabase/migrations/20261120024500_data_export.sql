-- =============================================================================
-- Download all your data (owner decision 2026-11-17; master plan §12 EX1). The website promises a full export when a
-- company leaves; this gives the owner a zip of spreadsheets of the company's own records plus its ticket photos and
-- order documents (src/server/data-export/, Settings → Download your data).
--
-- Who may: only an owner of the current company (an active membership with the role owner, not settings.manage), in
-- a session verified with two-step (aal2), never during a Taviron support visit, and only with billing.view (the export
-- holds invoices, payments and prices; the owner role holds it). Demo companies are allowed (fictional records).
--
--   * public.data_export_record(part)  records "data exported" in the company's audit log (who and when, which part;
--                                       never any contents). The server calls it before each download starts.
--   * public.data_export_summary()      how many records of each kind and how many files there are (for the page).
--   * public.data_export_rows(table, after)  one page (at most 1000 rows, by id) of one listed table, every column,
--                                       only rows of the caller's company. Only the tables named in
--                                       private.data_export_tables() can be read; anything else is refused.
--   * public.data_export_files(offset, limit)  the stored photos and documents (bucket, path, file name), only the
--                                       caller's company's, oldest first.
--
-- The company always comes from private.require_company() (never from the caller). Read-only except the audit entry.
-- Additive: no table, column or existing row changes.
-- Reversible: supabase/rollbacks/20261120024500_data_export.down.sql
-- =============================================================================

-- The tables the export reads, in the order the spreadsheets are listed. Fixed here: nothing else can be named.
create or replace function private.data_export_tables()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array[
    'customers', 'customer_contacts', 'customer_sites', 'materials', 'charge_items', 'price_lists', 'price_list_entries',
    'quotes', 'quote_lines', 'orders', 'order_lines', 'order_stops', 'order_loads', 'dispatch_assignments',
    'delivery_tickets', 'ticket_attachments', 'order_documents', 'invoices', 'invoice_orders', 'invoice_payments',
    'customer_payments', 'ticket_payment_applications', 'trucks', 'trailers', 'drivers', 'driver_qualifications',
    'haulers', 'employees', 'company_memberships', 'work_orders', 'work_order_tasks', 'fuel_purchases',
    'time_off_requests', 'pto_ledger'
  ]::text[]
$$;
revoke all on function private.data_export_tables() from public, anon, authenticated;

-- The caller's company when they may download all of its data; refuses otherwise. Called only from the functions
-- below (security definer), never by app users directly.
create or replace function private.data_export_company()
returns uuid
language plpgsql
stable
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
begin
  if private.support_company() is not null then
    raise exception 'Only the company''s owner can download all its data, not a Taviron support visit.' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.company_memberships m
     where m.company_id = v_company and m.user_id = auth.uid() and m.active and m.role = 'owner'
       and (m.access_ends_at is null or m.access_ends_at > now())
  ) then
    raise exception 'Only the company''s owner can download all its data.' using errcode = '42501';
  end if;
  if not private.aal2() then
    raise exception 'Confirm your two-step verification code first, then download your data.' using errcode = '42501';
  end if;
  if not private.has_permission('billing.view') then
    raise exception 'Downloading all data needs access to billing.' using errcode = '42501';
  end if;
  return v_company;
end;
$$;
revoke all on function private.data_export_company() from public, anon, authenticated;

create or replace function public.data_export_record(p_part text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.data_export_company();
begin
  if p_part is null or p_part !~ '^(spreadsheets|files-[1-9][0-9]{0,3})$' then
    raise exception 'Choose what to download.' using errcode = '22023';
  end if;
  insert into public.audit_events (company_id, actor_id, action, entity_type, entity_id, summary, details)
  values (v_company, auth.uid(), 'data_exported', 'company', v_company,
          case when p_part = 'spreadsheets' then 'Data exported: all records as spreadsheets'
               else 'Data exported: photos and documents, part ' || substr(p_part, 7) end,
          jsonb_build_object('part', p_part));
end;
$$;
revoke all on function public.data_export_record(text) from public, anon;
grant execute on function public.data_export_record(text) to authenticated;

create or replace function public.data_export_summary()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.data_export_company();
  v_counts jsonb := '{}'::jsonb;
  v_table text;
  v_n bigint;
begin
  foreach v_table in array private.data_export_tables() loop
    execute format('select count(*) from public.%I where company_id = $1', v_table) into v_n using v_company;
    v_counts := v_counts || jsonb_build_object(v_table, v_n);
  end loop;
  return jsonb_build_object(
    'counts', v_counts,
    'files', (select count(*) from public.ticket_attachments a where a.company_id = v_company and a.uploaded_at is not null and a.discarded_at is null)
           + (select count(*) from public.order_documents d where d.company_id = v_company and d.removed_at is null));
end;
$$;
revoke all on function public.data_export_summary() from public, anon;
grant execute on function public.data_export_summary() to authenticated;

-- One page of one table: every column as JSON, ordered by id, after p_after (null for the first page). The column
-- names come with every page so an empty table still gets its header row.
create or replace function public.data_export_rows(p_table text, p_after uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.data_export_company();
  v_rows jsonb;
  v_columns jsonb;
begin
  if p_table is null or not (p_table = any (private.data_export_tables())) then
    raise exception 'That is not part of the data download.' using errcode = '22023';
  end if;
  select coalesce(jsonb_agg(a.attname order by a.attnum), '[]'::jsonb) into v_columns
    from pg_attribute a
   where a.attrelid = ('public.' || quote_ident(p_table))::regclass and a.attnum > 0 and not a.attisdropped;
  execute format(
    'select coalesce(jsonb_agg(to_jsonb(t) order by t.id), ''[]''::jsonb)
       from (select * from public.%I x where x.company_id = $1 and ($2::uuid is null or x.id > $2) order by x.id limit 1000) t',
    p_table) into v_rows using v_company, p_after;
  return jsonb_build_object('columns', v_columns, 'rows', v_rows);
end;
$$;
revoke all on function public.data_export_rows(text, uuid) from public, anon;
grant execute on function public.data_export_rows(text, uuid) to authenticated;

-- The stored files of the caller's company: ticket photos and scans that were uploaded and not discarded, and order
-- documents that were not removed. Oldest first, then by id, so a part number always means the same files.
create or replace function public.data_export_files(p_offset integer, p_limit integer)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.data_export_company();
begin
  if p_offset is null or p_offset < 0 or p_limit is null or p_limit < 1 or p_limit > 1000 then
    raise exception 'Choose which files to download.' using errcode = '22023';
  end if;
  return coalesce((
    select jsonb_agg(f order by f.created_at, f.id)
      from (
        select f.* from (
          select a.id, a.created_at, 'ticket-photos'::text as bucket, a.object_path as path, a.mime_type as mime,
                 coalesce(nullif(a.ticket_number, ''), 'no-ticket') as label, a.kind
            from public.ticket_attachments a
           where a.company_id = v_company and a.uploaded_at is not null and a.discarded_at is null
          union all
          select d.id, d.created_at, 'order-documents'::text, d.object_path, d.mime_type, d.file_name, d.kind
            from public.order_documents d
           where d.company_id = v_company and d.removed_at is null
        ) f
        order by f.created_at, f.id
        offset p_offset limit p_limit
      ) f), '[]'::jsonb);
end;
$$;
revoke all on function public.data_export_files(integer, integer) from public, anon;
grant execute on function public.data_export_files(integer, integer) to authenticated;
