-- Order documents (MK2, owner 2026-11-05: "a rate confirmation attached to the load, bills of lading and proof of
-- delivery per stop"). Files on an order, optionally tied to one of its stops: rate confirmation, bill of lading, proof
-- of delivery, or other. Photos (JPEG, PNG, WebP) or PDFs, at most 10 MB each and 30 per order, in the private
-- order-documents bucket that only the server's service role reads and writes. The database decides who may add
-- (orders.edit) and who may open (orders.view), reserves the exact storage path, and keeps removed files on record
-- (removed_at, removed_by, reason). Nothing is sent anywhere.

create table public.order_documents (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies (id),
  order_id     uuid not null,
  stop_id      uuid references public.order_stops (id) on delete set null,
  kind         text not null check (kind in ('rate_confirmation', 'bill_of_lading', 'proof_of_delivery', 'other')),
  object_path  text not null unique check (object_path ~ '^[0-9a-f-]{36}/orders/[0-9a-f-]{36}\.(jpg|png|webp|pdf)$'),
  file_name    text not null check (length(btrim(file_name)) between 1 and 200),
  mime_type    text not null check (mime_type in ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')),
  size_bytes   integer not null check (size_bytes between 1 and 10485760),
  uploaded_by  uuid references auth.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  removed_at   timestamptz,
  removed_by   uuid references auth.users (id) on delete set null,
  remove_reason text not null default '' check (length(remove_reason) <= 300),
  unique (company_id, id),
  foreign key (company_id, order_id) references public.orders (company_id, id) on delete cascade,
  check ((removed_at is null) = (remove_reason = ''))
);
create index order_documents_order_idx on public.order_documents (order_id, created_at) where removed_at is null;

alter table public.order_documents enable row level security;
create policy order_documents_read on public.order_documents for select to authenticated
  using (company_id = (select private.current_company_id()) and (select private.has_permission('orders.view')));
revoke all on public.order_documents from anon;
grant select on public.order_documents to authenticated;

-- Reserve one file on an order: the person may edit orders, the stop (if any) is this order's, type and size are
-- allowed, the order has room. Returns the storage path the server then writes to.
create or replace function public.order_document_begin(p_order uuid, p_stop uuid, p_kind text, p_mime text, p_size integer, p_name text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v_path text;
  v_name text := left(btrim(regexp_replace(coalesce(p_name, ''), '[\x00-\x1f/\\]', '', 'g')), 200);
begin
  perform private.require_permission('orders.edit');
  if not exists (select 1 from public.orders where id = p_order and company_id = v_company) then
    raise exception 'Order not found.' using errcode = 'P0002';
  end if;
  if p_stop is not null and not exists (select 1 from public.order_stops s where s.id = p_stop and s.order_id = p_order and s.company_id = v_company and s.removed_at is null) then
    raise exception 'That stop is not on this order.' using errcode = '22023';
  end if;
  if p_kind is null or p_kind not in ('rate_confirmation', 'bill_of_lading', 'proof_of_delivery', 'other') then
    raise exception 'Choose what the document is.' using errcode = '22023';
  end if;
  if p_mime not in ('image/jpeg', 'image/png', 'image/webp', 'application/pdf') or p_size is null or p_size < 1 or p_size > 10485760 then
    raise exception 'Documents must be photos (JPEG, PNG, WebP) or PDFs, at most 10 MB each.' using errcode = '22023';
  end if;
  if (select count(*) from public.order_documents where order_id = p_order and removed_at is null) >= 30 then
    raise exception 'An order can hold at most 30 documents. Remove one first.' using errcode = '22023';
  end if;
  v_path := format('%s/orders/%s.%s', v_company, gen_random_uuid(),
                   case p_mime when 'image/png' then 'png' when 'image/webp' then 'webp' when 'application/pdf' then 'pdf' else 'jpg' end);
  insert into public.order_documents (company_id, order_id, stop_id, kind, object_path, file_name, mime_type, size_bytes, uploaded_by)
  values (v_company, p_order, p_stop, p_kind, v_path, coalesce(nullif(v_name, ''), 'document'), p_mime, p_size, auth.uid());
  perform private.log_event('order.document_added', 'order', p_order, format('Document added: %s', coalesce(nullif(v_name, ''), 'document')),
    jsonb_build_object('kind', p_kind, 'stop_id', p_stop));
  return v_path;
end;
$$;

-- Where a document is stored, for a person who may see orders (the server signs a one-minute link).
create or replace function public.order_document_path(p_document uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('path', d.object_path, 'name', d.file_name, 'type', d.mime_type)
    from public.order_documents d
   where d.id = p_document and d.removed_at is null
     and d.company_id = private.current_company_id() and private.has_permission('orders.view');
$$;

-- Remove a document from the order (kept on record with the reason; the stored file stays until retention rules apply).
create or replace function public.order_document_remove(p_document uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  d public.order_documents%rowtype;
  v_reason text := left(btrim(coalesce(p_reason, '')), 300);
begin
  perform private.require_permission('orders.edit');
  select * into d from public.order_documents where id = p_document and company_id = v_company and removed_at is null for update;
  if not found then
    raise exception 'Document not found.' using errcode = 'P0002';
  end if;
  if v_reason = '' then
    raise exception 'Give a reason for removing the document.' using errcode = '22023';
  end if;
  update public.order_documents set removed_at = now(), removed_by = auth.uid(), remove_reason = v_reason where id = d.id;
  perform private.log_event('order.document_removed', 'order', d.order_id, format('Document removed: %s (%s)', d.file_name, v_reason),
    jsonb_build_object('document_id', d.id));
end;
$$;

revoke all on function public.order_document_begin(uuid, uuid, text, text, integer, text), public.order_document_path(uuid),
  public.order_document_remove(uuid, text) from public, anon;
grant execute on function public.order_document_begin(uuid, uuid, text, text, integer, text), public.order_document_path(uuid),
  public.order_document_remove(uuid, text) to authenticated;

-- The private bucket (no policies: only the server's service role reads and writes it).
do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('order-documents', 'order-documents', false, 10485760, array['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
    on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
  end if;
end;
$$;
