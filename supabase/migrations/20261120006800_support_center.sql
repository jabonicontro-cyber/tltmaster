-- Customer support center (B138, owner 2026-11-04). Builds on the portal's support requests (20261120000700): the same
-- cases and messages, now with
--   * a case type (delivery problem, billing question, wrong material/quantity, other) and an optional link to one of
--     the customer's orders, tickets or invoices
--   * cases opened by the office for a customer (no portal account needed), assigned per case to a staff member
--   * internal notes (staff only; never in the portal)
--   * attachments: photos and PDFs, up to 5 per message, 10 MB each, in the private support-files bucket
--   * reopening by the customer within 14 days of closing; after that a new case
--   * a first-reply target set by each company (off until set); support_overdue() feeds the Command Center
-- Email notices to the customer are sent by the app (never from a demo company); support_notice_recipients() gives the
-- addresses. Additive: existing cases become type "other". Reversible: supabase/rollbacks/20261120006800_support_center.down.sql.

alter table public.portal_support_requests alter column account_id drop not null;
alter table public.portal_support_requests
  add column kind text not null default 'other' check (kind in ('delivery', 'billing', 'material', 'other')),
  add column assigned_to uuid references auth.users (id) on delete set null,
  add column ticket_id uuid,
  add column invoice_id uuid,
  add column opened_by_staff uuid references auth.users (id) on delete set null,
  add column first_reply_at timestamptz,
  add column closed_at timestamptz;
alter table public.portal_support_requests
  add constraint portal_support_requests_ticket_fkey foreign key (company_id, ticket_id) references public.delivery_tickets (company_id, id) on delete set null (ticket_id),
  add constraint portal_support_requests_invoice_fkey foreign key (company_id, invoice_id) references public.invoices (company_id, id) on delete set null (invoice_id),
  add constraint portal_support_requests_opener check (account_id is not null or opened_by_staff is not null);
create index portal_support_requests_open on public.portal_support_requests (company_id, status, created_at) where status <> 'closed';

alter table public.portal_messages add column internal boolean not null default false;
alter table public.portal_messages add constraint portal_messages_internal_staff check (not internal or author_kind = 'staff');

create table public.support_settings (
  company_id         uuid primary key references public.companies (id) on delete cascade,
  first_reply_hours  integer check (first_reply_hours between 1 and 168),
  updated_by         uuid references auth.users (id) on delete set null,
  updated_at         timestamptz not null default now()
);
alter table public.support_settings enable row level security;
create policy support_settings_read on public.support_settings for select to authenticated
  using (company_id = (select private.current_company_id()) and (select private.has_permission('customers.view')));
revoke all on public.support_settings from anon;
grant select on public.support_settings to authenticated;

create table public.portal_support_files (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies (id),
  request_id   uuid not null,
  message_id   uuid not null references public.portal_messages (id) on delete cascade,
  object_path  text not null unique check (object_path ~ '^[0-9a-f-]{36}/support/[0-9a-f-]{36}\.(jpg|png|webp|pdf)$'),
  file_name    text not null check (length(btrim(file_name)) between 1 and 200),
  mime_type    text not null check (mime_type in ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')),
  size_bytes   integer not null check (size_bytes between 1 and 10485760),
  uploaded_by  uuid references auth.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  foreign key (company_id, request_id) references public.portal_support_requests (company_id, id) on delete cascade
);
create index portal_support_files_message on public.portal_support_files (message_id);
alter table public.portal_support_files enable row level security;
create policy portal_support_files_read on public.portal_support_files for select to authenticated
  using (company_id = (select private.current_company_id()) and (select private.has_permission('customers.view')));
revoke all on public.portal_support_files from anon;
grant select on public.portal_support_files to authenticated;

-- Shared checks ------------------------------------------------------------------------------------------------------
-- The linked order, ticket and invoice must belong to this customer.
create or replace function private.support_check_links(p_company uuid, p_customer uuid, p_order uuid, p_ticket uuid, p_invoice uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_order is not null and not exists (select 1 from public.orders where id = p_order and company_id = p_company and customer_id = p_customer and status <> 'draft') then
    raise exception 'Order not found.' using errcode = 'P0002';
  end if;
  if p_ticket is not null and not exists (select 1 from public.delivery_tickets t join public.orders o on o.id = t.order_id and o.company_id = t.company_id
                                          where t.id = p_ticket and t.company_id = p_company and o.customer_id = p_customer) then
    raise exception 'Ticket not found.' using errcode = 'P0002';
  end if;
  if p_invoice is not null and not exists (select 1 from public.invoices where id = p_invoice and company_id = p_company and customer_id = p_customer and status <> 'draft') then
    raise exception 'Invoice not found.' using errcode = 'P0002';
  end if;
end;
$$;

create or replace function private.support_kind(p_kind text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
begin
  if coalesce(p_kind, '') not in ('delivery', 'billing', 'material', 'other') then
    raise exception 'Choose what the case is about.' using errcode = '22023';
  end if;
  return p_kind;
end;
$$;

-- Reserve a path for one attachment on a message (at most 5 per message).
create or replace function private.support_file_reserve(p_company uuid, p_request uuid, p_message uuid, p_mime text, p_size integer, p_name text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_path text;
  v_name text := left(btrim(regexp_replace(coalesce(p_name, ''), '[\x00-\x1f/\\]', '', 'g')), 200);
begin
  if p_mime not in ('image/jpeg', 'image/png', 'image/webp', 'application/pdf') or p_size is null or p_size < 1 or p_size > 10485760 then
    raise exception 'Attachments must be photos (JPEG, PNG, WebP) or PDFs, at most 10 MB each.' using errcode = '22023';
  end if;
  if (select count(*) from public.portal_support_files where message_id = p_message) >= 5 then
    raise exception 'At most 5 attachments per message.' using errcode = '22023';
  end if;
  v_path := format('%s/support/%s.%s', p_company, gen_random_uuid(),
                   case p_mime when 'image/png' then 'png' when 'image/webp' then 'webp' when 'application/pdf' then 'pdf' else 'jpg' end);
  insert into public.portal_support_files (company_id, request_id, message_id, object_path, file_name, mime_type, size_bytes, uploaded_by)
  values (p_company, p_request, p_message, v_path, coalesce(nullif(v_name, ''), 'attachment'), p_mime, p_size, auth.uid());
  return v_path;
end;
$$;

revoke all on function private.support_check_links(uuid, uuid, uuid, uuid, uuid), private.support_kind(text),
  private.support_file_reserve(uuid, uuid, uuid, text, integer, text) from public, anon, authenticated;

-- Customer (portal) ---------------------------------------------------------------------------------------------------
create or replace function public.portal_support_open(p_slug text, p_kind text, p_subject text, p_message text,
                                                      p_order uuid default null, p_ticket uuid default null, p_invoice uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.portal_accounts%rowtype := private.portal_me(p_slug);
  v_kind text := private.support_kind(p_kind);
  v_subject text := private.clean_text(p_subject, 160, 'Subject');
  v_message text := private.clean_text(p_message, 4000, 'Message');
  v_id uuid;
  v_msg uuid;
begin
  perform private.portal_require_feature(v.company_id, 'support');
  if length(v_subject) = 0 or length(v_message) < 5 then
    raise exception 'Enter a subject and a message.' using errcode = '22023';
  end if;
  perform private.support_check_links(v.company_id, v.customer_id, p_order, p_ticket, p_invoice);
  perform private.portal_rate(v.id, 'support', 10);
  insert into public.portal_support_requests (company_id, customer_id, account_id, order_id, ticket_id, invoice_id, subject, kind)
  values (v.company_id, v.customer_id, v.id, p_order, p_ticket, p_invoice, v_subject, v_kind) returning id into v_id;
  insert into public.portal_messages (company_id, request_id, author_kind, author_id, body)
  values (v.company_id, v_id, 'customer', auth.uid(), v_message) returning id into v_msg;
  perform private.portal_log(v.company_id, 'portal.support_requested', 'portal_support_request', v_id, format('%s: %s', v.email, v_subject));
  return jsonb_build_object('id', v_id, 'message_id', v_msg);
end;
$$;

-- A customer's message on their case. A closed case reopens when the customer writes within 14 days of closing;
-- after that they open a new case.
create or replace function public.portal_support_send(p_slug text, p_request uuid, p_body text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.portal_accounts%rowtype := private.portal_me(p_slug);
  v_body text := private.clean_text(p_body, 4000, 'Message');
  r public.portal_support_requests%rowtype;
  v_msg uuid;
begin
  perform private.portal_require_feature(v.company_id, 'support');
  if length(v_body) = 0 then
    raise exception 'Enter a message.' using errcode = '22023';
  end if;
  select * into r from public.portal_support_requests where id = p_request and company_id = v.company_id and customer_id = v.customer_id for update;
  if not found then
    raise exception 'Request not found.' using errcode = 'P0002';
  end if;
  if r.status = 'closed' and coalesce(r.closed_at, r.updated_at) < now() - interval '14 days' then
    raise exception 'This case was closed more than 14 days ago. Open a new case.' using errcode = 'P0001';
  end if;
  perform private.portal_rate(v.id, 'support_reply', 50);
  insert into public.portal_messages (company_id, request_id, author_kind, author_id, body)
  values (v.company_id, p_request, 'customer', auth.uid(), v_body) returning id into v_msg;
  update public.portal_support_requests set status = 'open', closed_at = null, updated_at = now() where id = p_request;
  return v_msg;
end;
$$;

-- The original reply function (same signature), now with the 14-day reopening rule.
create or replace function public.portal_support_reply(p_slug text, p_request uuid, p_body text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.portal_support_send(p_slug, p_request, p_body);
end;
$$;

-- The customer's cases and one case: never internal notes; attachments of visible messages only.
create or replace function public.portal_support_list(p_slug text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v public.portal_accounts%rowtype := private.portal_me(p_slug);
begin
  perform private.portal_require_feature(v.company_id, 'support');
  return (select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'subject', r.subject, 'status', r.status, 'kind', r.kind,
            'created_at', r.created_at, 'updated_at', r.updated_at,
            'order_number', (select o.order_number from public.orders o where o.id = r.order_id)) order by r.updated_at desc), '[]'::jsonb)
          from public.portal_support_requests r where r.company_id = v.company_id and r.customer_id = v.customer_id);
end;
$$;

create or replace function public.portal_support_thread(p_slug text, p_request uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v public.portal_accounts%rowtype := private.portal_me(p_slug);
  r jsonb;
begin
  perform private.portal_require_feature(v.company_id, 'support');
  select jsonb_build_object('id', s.id, 'subject', s.subject, 'status', s.status, 'kind', s.kind, 'created_at', s.created_at,
           'closed_at', s.closed_at,
           'can_reopen', s.status <> 'closed' or coalesce(s.closed_at, s.updated_at) >= now() - interval '14 days',
           'order_number', (select o.order_number from public.orders o where o.id = s.order_id),
           'ticket_number', (select t.ticket_number from public.delivery_tickets t where t.id = s.ticket_id),
           'invoice_number', (select i.number from public.invoices i where i.id = s.invoice_id),
           'messages', (select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'from', m.author_kind, 'body', m.body, 'at', m.created_at,
                          'files', (select coalesce(jsonb_agg(jsonb_build_object('id', f.id, 'name', f.file_name, 'type', f.mime_type) order by f.created_at), '[]'::jsonb)
                                    from public.portal_support_files f where f.message_id = m.id)) order by m.created_at), '[]'::jsonb)
                        from public.portal_messages m where m.request_id = s.id and not m.internal))
    into r
  from public.portal_support_requests s where s.id = p_request and s.company_id = v.company_id and s.customer_id = v.customer_id;
  if r is null then
    raise exception 'Request not found.' using errcode = 'P0002';
  end if;
  return r;
end;
$$;

-- The customer's own orders, tickets and invoices to link a case to (most recent first).
create or replace function public.portal_support_link_options(p_slug text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v public.portal_accounts%rowtype := private.portal_me(p_slug);
begin
  perform private.portal_require_feature(v.company_id, 'support');
  return jsonb_build_object(
    'orders', (select coalesce(jsonb_agg(jsonb_build_object('id', o.id, 'label', o.order_number) order by o.created_at desc), '[]'::jsonb)
               from (select * from public.orders where company_id = v.company_id and customer_id = v.customer_id and status <> 'draft' order by created_at desc limit 50) o),
    'tickets', (select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'label', t.ticket_number) order by t.created_at desc), '[]'::jsonb)
                from (select t.* from public.delivery_tickets t join public.orders o on o.id = t.order_id and o.company_id = t.company_id
                      where t.company_id = v.company_id and o.customer_id = v.customer_id and t.status <> 'superseded' order by t.created_at desc limit 50) t),
    'invoices', (select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'label', i.number) order by i.created_at desc), '[]'::jsonb)
                 from (select * from public.invoices where company_id = v.company_id and customer_id = v.customer_id and status <> 'draft' order by created_at desc limit 50) i));
end;
$$;

-- An attachment on the customer's own message, within 30 minutes of writing it.
create or replace function public.portal_support_file_begin(p_slug text, p_message uuid, p_mime text, p_size integer, p_name text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.portal_accounts%rowtype := private.portal_me(p_slug);
  m public.portal_messages%rowtype;
begin
  perform private.portal_require_feature(v.company_id, 'support');
  select msg.* into m from public.portal_messages msg join public.portal_support_requests r on r.id = msg.request_id
   where msg.id = p_message and msg.company_id = v.company_id and r.customer_id = v.customer_id
     and msg.author_kind = 'customer' and msg.author_id = auth.uid() and msg.created_at > now() - interval '30 minutes';
  if not found then
    raise exception 'Message not found.' using errcode = 'P0002';
  end if;
  return private.support_file_reserve(v.company_id, m.request_id, m.id, p_mime, p_size, p_name);
end;
$$;

create or replace function public.portal_support_file_path(p_slug text, p_file uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v public.portal_accounts%rowtype := private.portal_me(p_slug);
begin
  return (select jsonb_build_object('path', f.object_path, 'name', f.file_name, 'type', f.mime_type)
            from public.portal_support_files f
            join public.portal_messages m on m.id = f.message_id and not m.internal
            join public.portal_support_requests r on r.id = f.request_id
           where f.id = p_file and f.company_id = v.company_id and r.customer_id = v.customer_id);
end;
$$;

-- Office --------------------------------------------------------------------------------------------------------------
-- Open a case for a customer (from a phone call, an email, a visit). The opening message is visible to the customer.
create or replace function public.support_open_case(p_customer uuid, p_kind text, p_subject text, p_message text,
                                                    p_order uuid default null, p_ticket uuid default null, p_invoice uuid default null,
                                                    p_assign uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v_kind text := private.support_kind(p_kind);
  v_subject text := private.clean_text(p_subject, 160, 'Subject');
  v_message text := private.clean_text(p_message, 4000, 'Message');
  v_id uuid;
  v_msg uuid;
begin
  perform private.require_permission('customers.edit');
  if not exists (select 1 from public.customers where id = p_customer and company_id = v_company) then
    raise exception 'Customer not found.' using errcode = 'P0002';
  end if;
  if length(v_subject) = 0 or length(v_message) < 5 then
    raise exception 'Enter a subject and a message.' using errcode = '22023';
  end if;
  if p_assign is not null and not exists (select 1 from public.company_memberships where company_id = v_company and user_id = p_assign and active) then
    raise exception 'Choose someone from your company.' using errcode = '22023';
  end if;
  perform private.support_check_links(v_company, p_customer, p_order, p_ticket, p_invoice);
  insert into public.portal_support_requests (company_id, customer_id, account_id, order_id, ticket_id, invoice_id, subject, kind,
                                              assigned_to, opened_by_staff, first_reply_at, status)
  values (v_company, p_customer, null, p_order, p_ticket, p_invoice, v_subject, v_kind, coalesce(p_assign, auth.uid()), auth.uid(), now(), 'answered')
  returning id into v_id;
  insert into public.portal_messages (company_id, request_id, author_kind, author_id, body)
  values (v_company, v_id, 'staff', auth.uid(), v_message) returning id into v_msg;
  perform private.log_event('support.case_opened', 'portal_support_request', v_id, format('Support case opened: %s', v_subject), jsonb_build_object('kind', v_kind));
  return jsonb_build_object('id', v_id, 'message_id', v_msg);
end;
$$;

-- A reply to the customer, or an internal note (staff only), and/or closing the case.
create or replace function public.support_reply(p_request uuid, p_body text, p_internal boolean default false, p_close boolean default false)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v_body text := private.clean_text(p_body, 4000, 'Reply');
  r public.portal_support_requests%rowtype;
  v_msg uuid;
begin
  perform private.require_permission('customers.edit');
  select * into r from public.portal_support_requests where id = p_request and company_id = v_company for update;
  if not found then
    raise exception 'Request not found.' using errcode = 'P0002';
  end if;
  if length(v_body) = 0 and not coalesce(p_close, false) then
    raise exception 'Enter a reply or a note.' using errcode = '22023';
  end if;
  if length(v_body) > 0 then
    insert into public.portal_messages (company_id, request_id, author_kind, author_id, body, internal)
    values (v_company, p_request, 'staff', auth.uid(), v_body, coalesce(p_internal, false)) returning id into v_msg;
  end if;
  update public.portal_support_requests set
    status = case when coalesce(p_close, false) then 'closed'
                  when length(v_body) > 0 and not coalesce(p_internal, false) then 'answered' else status end,
    closed_at = case when coalesce(p_close, false) then now() when status = 'closed' and length(v_body) > 0 and not coalesce(p_internal, false) then null else closed_at end,
    first_reply_at = case when length(v_body) > 0 and not coalesce(p_internal, false) then coalesce(first_reply_at, now()) else first_reply_at end,
    assigned_to = coalesce(assigned_to, auth.uid()),
    updated_at = now()
  where id = p_request;
  perform private.log_event(case when coalesce(p_internal, false) then 'support.note_added' else 'portal.support_replied' end,
    'portal_support_request', p_request,
    case when coalesce(p_internal, false) then 'Internal note on a support case' when length(v_body) > 0 then 'Replied to a support case' else 'Closed a support case' end,
    jsonb_build_object('closed', coalesce(p_close, false)));
  return v_msg;
end;
$$;

-- Change the type, the person it is assigned to, or the linked order, ticket or invoice.
create or replace function public.support_update(p_request uuid, p_kind text, p_assign uuid, p_order uuid, p_ticket uuid, p_invoice uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  r public.portal_support_requests%rowtype;
begin
  perform private.require_permission('customers.edit');
  select * into r from public.portal_support_requests where id = p_request and company_id = v_company for update;
  if not found then
    raise exception 'Request not found.' using errcode = 'P0002';
  end if;
  if p_assign is not null and not exists (select 1 from public.company_memberships where company_id = v_company and user_id = p_assign and active) then
    raise exception 'Choose someone from your company.' using errcode = '22023';
  end if;
  perform private.support_check_links(v_company, r.customer_id, p_order, p_ticket, p_invoice);
  update public.portal_support_requests set kind = private.support_kind(p_kind), assigned_to = p_assign,
    order_id = p_order, ticket_id = p_ticket, invoice_id = p_invoice, updated_at = now()
  where id = p_request;
  perform private.log_event('support.case_updated', 'portal_support_request', p_request, 'Support case updated',
    jsonb_build_object('kind', p_kind, 'assigned_to', p_assign));
end;
$$;

create or replace function public.support_file_begin(p_message uuid, p_mime text, p_size integer, p_name text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  m public.portal_messages%rowtype;
begin
  perform private.require_permission('customers.edit');
  select * into m from public.portal_messages where id = p_message and company_id = v_company and author_kind = 'staff' and created_at > now() - interval '30 minutes';
  if not found then
    raise exception 'Message not found.' using errcode = 'P0002';
  end if;
  return private.support_file_reserve(v_company, m.request_id, m.id, p_mime, p_size, p_name);
end;
$$;

create or replace function public.support_file_path(p_file uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('path', f.object_path, 'name', f.file_name, 'type', f.mime_type)
    from public.portal_support_files f
   where f.id = p_file and f.company_id = private.current_company_id() and private.has_permission('customers.view');
$$;

-- The company's first-reply target in hours; null turns it off.
create or replace function public.support_save_settings(p_first_reply_hours integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
begin
  perform private.require_permission('settings.manage');
  if p_first_reply_hours is not null and (p_first_reply_hours < 1 or p_first_reply_hours > 168) then
    raise exception 'The first-reply target is 1 to 168 hours, or empty to turn it off.' using errcode = '22023';
  end if;
  insert into public.support_settings (company_id, first_reply_hours, updated_by, updated_at)
  values (v_company, p_first_reply_hours, auth.uid(), now())
  on conflict (company_id) do update set first_reply_hours = excluded.first_reply_hours, updated_by = excluded.updated_by, updated_at = now();
  perform private.log_event('support.settings_saved', 'company', v_company,
    case when p_first_reply_hours is null then 'Support first-reply target turned off' else format('Support first-reply target: %s h', p_first_reply_hours) end, '{}'::jsonb);
end;
$$;

-- Open cases still waiting for a first reply past the company's target (for the Command Center). Off until set.
create or replace function public.support_overdue()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v_hours integer;
begin
  perform private.require_permission('customers.view');
  select first_reply_hours into v_hours from public.support_settings where company_id = v_company;
  if v_hours is null then
    return jsonb_build_object('target_hours', null, 'count', 0, 'oldest', null);
  end if;
  return (select jsonb_build_object('target_hours', v_hours, 'count', count(*), 'oldest', min(r.created_at))
            from public.portal_support_requests r
           where r.company_id = v_company and r.status = 'open' and r.first_reply_at is null
             and r.created_at < now() - make_interval(hours => v_hours));
end;
$$;

-- Where to send the "you have a reply" notice: the customer's active portal logins (the app sends it; demos never).
create or replace function public.support_notice_recipients(p_request uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  r public.portal_support_requests%rowtype;
begin
  perform private.require_permission('customers.edit');
  select * into r from public.portal_support_requests where id = p_request and company_id = v_company;
  if not found then
    raise exception 'Request not found.' using errcode = 'P0002';
  end if;
  return jsonb_build_object(
    'emails', (select coalesce(jsonb_agg(distinct a.email), '[]'::jsonb) from public.portal_accounts a
               where a.company_id = v_company and a.customer_id = r.customer_id and a.status = 'active'),
    'slug', (select c.slug from public.companies c where c.id = v_company),
    'company', (select coalesce(nullif(p.display_name, ''), c.name) from public.companies c left join public.portal_settings p on p.company_id = c.id where c.id = v_company),
    'subject', r.subject);
end;
$$;

-- Demo samples: a 4-hour first-reply target and three cases (one waiting past the target, one answered with an
-- internal note, one closed recently). Demo companies only, by their owner; once.
create or replace function public.demo_support_samples()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_demo uuid := private.demo_owner_company();
  v_customers uuid[];
  v_order uuid;
  v_id uuid;
begin
  if v_demo is null then
    raise exception 'Demo samples are only added to a demo company, by its owner.' using errcode = '42501';
  end if;
  if exists (select 1 from public.support_settings where company_id = v_demo) then
    return 0;
  end if;
  insert into public.support_settings (company_id, first_reply_hours, updated_by) values (v_demo, 4, auth.uid());
  select array_agg(id order by name) into v_customers from (select id, name from public.customers where company_id = v_demo order by name limit 3) c;
  if coalesce(array_length(v_customers, 1), 0) = 0 then
    return 1;
  end if;
  select id into v_order from public.orders where company_id = v_demo and customer_id = v_customers[1] and status <> 'draft' order by created_at desc limit 1;

  insert into public.portal_support_requests (company_id, customer_id, opened_by_staff, order_id, subject, kind, status, created_at, updated_at)
  values (v_demo, v_customers[1], auth.uid(), v_order, 'Load arrived after the crew left (demo)', 'delivery', 'open', now() - interval '6 hours', now() - interval '6 hours')
  returning id into v_id;
  insert into public.portal_messages (company_id, request_id, author_kind, author_id, body, created_at)
  values (v_demo, v_id, 'customer', null, 'The second load came at 3:40 and our crew had already left. Can we plan tomorrow''s loads earlier? (demo)', now() - interval '6 hours');

  if array_length(v_customers, 1) >= 2 then
    insert into public.portal_support_requests (company_id, customer_id, opened_by_staff, subject, kind, status, assigned_to, first_reply_at, created_at, updated_at)
    values (v_demo, v_customers[2], auth.uid(), 'Question about last month''s fuel surcharge (demo)', 'billing', 'answered', auth.uid(), now() - interval '20 hours', now() - interval '1 day', now() - interval '20 hours')
    returning id into v_id;
    insert into public.portal_messages (company_id, request_id, author_kind, author_id, body, internal, created_at) values
      (v_demo, v_id, 'customer', null, 'Why is there a fuel surcharge on the October invoice? (demo)', false, now() - interval '1 day'),
      (v_demo, v_id, 'staff', auth.uid(), 'Check the surcharge table before replying; the rate changed on the 15th. (internal note, demo)', true, now() - interval '21 hours'),
      (v_demo, v_id, 'staff', auth.uid(), 'The surcharge follows the weekly diesel index on your contract. We attached the breakdown. (demo)', false, now() - interval '20 hours');
  end if;

  if array_length(v_customers, 1) >= 3 then
    insert into public.portal_support_requests (company_id, customer_id, opened_by_staff, subject, kind, status, assigned_to, first_reply_at, closed_at, created_at, updated_at)
    values (v_demo, v_customers[3], auth.uid(), 'Received 57 instead of #53 stone (demo)', 'material', 'closed', auth.uid(), now() - interval '3 days', now() - interval '2 days', now() - interval '3 days', now() - interval '2 days')
    returning id into v_id;
    insert into public.portal_messages (company_id, request_id, author_kind, author_id, body, created_at) values
      (v_demo, v_id, 'customer', null, 'Ticket shows #53 but the pile looks like 57 stone. (demo)', now() - interval '3 days'),
      (v_demo, v_id, 'staff', auth.uid(), 'You were right: the plant loaded the wrong bin. We swapped it this morning at no charge. (demo)', now() - interval '2 days');
  end if;
  return 4;
end;
$$;

revoke all on function public.portal_support_open(text, text, text, text, uuid, uuid, uuid), public.portal_support_send(text, uuid, text),
  public.portal_support_link_options(text), public.portal_support_file_begin(text, uuid, text, integer, text), public.portal_support_file_path(text, uuid),
  public.support_open_case(uuid, text, text, text, uuid, uuid, uuid, uuid), public.support_reply(uuid, text, boolean, boolean),
  public.support_update(uuid, text, uuid, uuid, uuid, uuid), public.support_file_begin(uuid, text, integer, text), public.support_file_path(uuid),
  public.support_save_settings(integer), public.support_overdue(), public.support_notice_recipients(uuid), public.demo_support_samples() from public, anon;
grant execute on function public.portal_support_open(text, text, text, text, uuid, uuid, uuid), public.portal_support_send(text, uuid, text),
  public.portal_support_link_options(text), public.portal_support_file_begin(text, uuid, text, integer, text), public.portal_support_file_path(text, uuid),
  public.support_open_case(uuid, text, text, text, uuid, uuid, uuid, uuid), public.support_reply(uuid, text, boolean, boolean),
  public.support_update(uuid, text, uuid, uuid, uuid, uuid), public.support_file_begin(uuid, text, integer, text), public.support_file_path(uuid),
  public.support_save_settings(integer), public.support_overdue(), public.support_notice_recipients(uuid), public.demo_support_samples() to authenticated;

-- The private bucket (no policies: only the server's service role reads and writes it).
do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('support-files', 'support-files', false, 10485760, array['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
    on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
  end if;
end;
$$;
