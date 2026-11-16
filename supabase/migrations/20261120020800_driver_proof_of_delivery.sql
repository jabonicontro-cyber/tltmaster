-- Drivers add proof of delivery from the phone at a stop (MK2, owner 2026-11-05: "bills of lading and proof of
-- delivery per stop"; the last open part of MK2). Until now order documents needed orders.edit (20261120009500), so
-- only the office could add them. Now the assigned driver can add a proof-of-delivery photo or PDF to a delivery stop
-- of their OWN active assignment, from My Day:
--
--   * public.driver_pod_begin: the driver (private.portal_driver: driver.portal and a linked, active driver record)
--     names their assignment and one of its order's delivery stops. The assignment must be theirs and active, the load
--     from two days ago to today (the same window as ticket photos), the order not canceled. Photos (JPEG, PNG, WebP)
--     or PDFs, at most 10 MB, at most 5 per stop and load from drivers, and the order's 30-document limit still holds.
--     The kind is always proof_of_delivery: a driver never adds a rate confirmation or any other document. Retrying
--     with the same upload key returns the same record (a lost response at a stop with weak signal never adds a second
--     copy). Returns the storage path; the server then stores the file there with the service role (the bucket keeps
--     no policies: nobody's own token reads or writes it), as for the office's documents. Audited.
--   * public.driver_stop_proofs: what the driver themselves added for their own active assignments' loads (file name and
--     time, per load and stop). Never other drivers' or the office's documents, never paths.
--
-- The office sees the driver's documents where it sees the order's documents (orders.view, unchanged policy), now with
-- the load they belong to (order_documents.load_id) and who added them; they open, and are removed with a reason, as
-- before (orders.edit). Nothing about money. Nothing is sent anywhere.
--
-- Additive: two nullable columns, one index, two functions. Reversible:
-- supabase/rollbacks/20261120020800_driver_proof_of_delivery.down.sql

-- The load a driver's document belongs to (an order's stops are shared by all of its loads), and the upload key that
-- makes a retry safe. Both empty for the office's documents. A canceled load keeps its documents; a deleted sample load
-- only clears the link.
alter table public.order_documents add column if not exists load_id uuid;
alter table public.order_documents add column if not exists upload_key uuid;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'order_documents_load_fk' and conrelid = 'public.order_documents'::regclass) then
    alter table public.order_documents add constraint order_documents_load_fk
      foreign key (company_id, load_id) references public.order_loads (company_id, id) on delete set null (load_id);
  end if;
end;
$$;
create unique index if not exists order_documents_upload_key on public.order_documents (company_id, upload_key) where upload_key is not null;
create index if not exists order_documents_load_idx on public.order_documents (load_id, stop_id) where load_id is not null and removed_at is null;

-- Reserve one proof of delivery for a stop of the driver's own active load. Returns {document_id, path, existing}.
create or replace function public.driver_pod_begin(p_assignment uuid, p_stop uuid, p_upload_key uuid, p_mime text, p_size integer, p_name text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_d     public.drivers%rowtype := private.portal_driver();
  v_today date := private.business_today(v_d.company_id);
  v_a     public.dispatch_assignments%rowtype;
  v_l     public.order_loads%rowtype;
  v_s     public.order_stops%rowtype;
  v_doc   public.order_documents%rowtype;
  v_path  text;
  v_id    uuid := gen_random_uuid();
  v_name  text := left(btrim(regexp_replace(coalesce(p_name, ''), '[\x00-\x1f/\\]', '', 'g')), 200);
begin
  if p_upload_key is null then
    raise exception 'Missing upload key. Reload the page.' using errcode = '22023';
  end if;
  -- A retry of the same upload: the same record, only for the person who started it.
  select * into v_doc from public.order_documents where company_id = v_d.company_id and upload_key = p_upload_key;
  if found then
    if v_doc.uploaded_by is distinct from auth.uid() then
      raise exception 'This upload was already used.' using errcode = '42501';
    end if;
    if v_doc.removed_at is not null then
      raise exception 'This photo was not stored. Take it again.' using errcode = '22023';
    end if;
    return jsonb_build_object('document_id', v_doc.id, 'path', v_doc.object_path, 'existing', true);
  end if;

  select * into v_a from public.dispatch_assignments
   where id = p_assignment and company_id = v_d.company_id and driver_id = v_d.id and status = 'active';
  if not found then
    raise exception 'This load is not assigned to you (or the assignment changed). Refresh your list.' using errcode = '42501';
  end if;
  select * into v_l from public.order_loads where id = v_a.load_id and company_id = v_d.company_id;
  if v_l.status <> 'planned' or exists (select 1 from public.orders o where o.id = v_l.order_id and o.status = 'canceled') then
    raise exception 'This load was canceled. Ask dispatch.' using errcode = '22023';
  end if;
  if v_l.load_date > v_today or v_l.load_date < v_today - 2 then
    raise exception 'Proof of delivery can be added for loads from two days ago to today.' using errcode = '22023';
  end if;
  select * into v_s from public.order_stops
   where id = p_stop and order_id = v_l.order_id and company_id = v_d.company_id and removed_at is null;
  if not found then
    raise exception 'That stop is not on this load.' using errcode = '22023';
  end if;
  if v_s.kind <> 'delivery' then
    raise exception 'Proof of delivery is added at a delivery stop.' using errcode = '22023';
  end if;
  if p_mime is null or p_mime not in ('image/jpeg', 'image/png', 'image/webp', 'application/pdf') or p_size is null or p_size < 1 or p_size > 10485760 then
    raise exception 'Proof of delivery must be a photo (JPEG, PNG, WebP) or a PDF, at most 10 MB.' using errcode = '22023';
  end if;
  if (select count(*) from public.order_documents
       where company_id = v_d.company_id and load_id = v_l.id and stop_id = v_s.id and removed_at is null) >= 5 then
    raise exception 'This stop already has 5 proofs of delivery for your load. Ask the office to remove a wrong one.' using errcode = '22023';
  end if;
  if (select count(*) from public.order_documents where order_id = v_l.order_id and removed_at is null) >= 30 then
    raise exception 'This order already holds 30 documents. Ask the office to make room.' using errcode = '22023';
  end if;

  v_path := format('%s/orders/%s.%s', v_d.company_id, v_id,
                   case p_mime when 'image/png' then 'png' when 'image/webp' then 'webp' when 'application/pdf' then 'pdf' else 'jpg' end);
  insert into public.order_documents (id, company_id, order_id, stop_id, load_id, upload_key, kind, object_path, file_name, mime_type, size_bytes, uploaded_by)
  values (v_id, v_d.company_id, v_l.order_id, v_s.id, v_l.id, p_upload_key, 'proof_of_delivery', v_path,
          coalesce(nullif(v_name, ''), 'proof-of-delivery'), p_mime, p_size, auth.uid());
  perform private.log_event('order.document_added', 'order', v_l.order_id,
    format('Proof of delivery added by %s for load %s at stop %s (%s)',
           coalesce((select nullif(btrim(full_name), '') from public.profiles where id = auth.uid()), 'the driver'),
           v_l.load_number, v_s.seq, v_s.name),
    jsonb_build_object('kind', 'proof_of_delivery', 'stop_id', v_s.id, 'load_id', v_l.id, 'document_id', v_id, 'source', 'driver'));
  return jsonb_build_object('document_id', v_id, 'path', v_path, 'existing', false);
end;
$$;

-- The driver's own proofs of delivery on their own active loads (from two days ago to tomorrow, as their stops are
-- listed): {load_id: {stop_id: [{id, name, at}]}}. Nothing else: no paths, no other people's documents.
create or replace function public.driver_stop_proofs()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_d     public.drivers%rowtype := private.portal_driver();
  v_today date := private.business_today(v_d.company_id);
begin
  return coalesce((
    select jsonb_object_agg(x.load_id, x.stops)
      from (
        select y.load_id, jsonb_object_agg(y.stop_id, y.docs) as stops
          from (
            select d.load_id, d.stop_id,
                   jsonb_agg(jsonb_build_object('id', d.id, 'name', d.file_name, 'at', d.created_at) order by d.created_at) as docs
              from public.order_documents d
              join public.dispatch_assignments a on a.load_id = d.load_id and a.company_id = d.company_id
              join public.order_loads l on l.id = a.load_id and l.company_id = a.company_id
             where d.company_id = v_d.company_id and d.uploaded_by = auth.uid() and d.removed_at is null
               and d.stop_id is not null and d.kind = 'proof_of_delivery'
               and a.driver_id = v_d.id and a.status = 'active'
               and l.load_date between v_today - 2 and v_today + 1
             group by d.load_id, d.stop_id
          ) y
         group by y.load_id
      ) x), '{}'::jsonb);
end;
$$;

revoke all on function public.driver_pod_begin(uuid, uuid, uuid, text, integer, text), public.driver_stop_proofs() from public, anon;
grant execute on function public.driver_pod_begin(uuid, uuid, uuid, text, integer, text), public.driver_stop_proofs() to authenticated;
