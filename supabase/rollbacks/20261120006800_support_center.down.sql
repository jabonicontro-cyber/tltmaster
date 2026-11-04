-- Rollback for 20261120006800_support_center.sql: restores the portal support functions of 20261120000700 and removes
-- case types, assignment, links, internal notes, attachments and the first-reply target. Cases opened by the office
-- (no portal account) and internal notes are removed first, because the original tables cannot hold them. Files in the
-- support-files bucket are left in place (remove them from Storage separately if wanted).
begin;

create or replace function public.portal_support_list(p_slug text)
 returns jsonb
 language plpgsql
 stable
 security definer
 set search_path to ''
as $$
declare
  v public.portal_accounts%rowtype := private.portal_me(p_slug);
begin
  perform private.portal_require_feature(v.company_id, 'support');
  return (select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'subject', r.subject, 'status', r.status, 'created_at', r.created_at, 'updated_at', r.updated_at,
            'order_number', (select o.order_number from public.orders o where o.id = r.order_id)) order by r.updated_at desc), '[]'::jsonb)
          from public.portal_support_requests r where r.company_id = v.company_id and r.customer_id = v.customer_id);
end;
$$;

create or replace function public.portal_support_thread(p_slug text, p_request uuid)
 returns jsonb
 language plpgsql
 stable
 security definer
 set search_path to ''
as $$
declare
  v public.portal_accounts%rowtype := private.portal_me(p_slug);
  r jsonb;
begin
  perform private.portal_require_feature(v.company_id, 'support');
  select jsonb_build_object('id', s.id, 'subject', s.subject, 'status', s.status, 'created_at', s.created_at,
           'order_number', (select o.order_number from public.orders o where o.id = s.order_id),
           'messages', (select coalesce(jsonb_agg(jsonb_build_object('from', m.author_kind, 'body', m.body, 'at', m.created_at) order by m.created_at), '[]'::jsonb)
                        from public.portal_messages m where m.request_id = s.id))
    into r
  from public.portal_support_requests s where s.id = p_request and s.company_id = v.company_id and s.customer_id = v.customer_id;
  if r is null then
    raise exception 'Request not found.' using errcode = 'P0002';
  end if;
  return r;
end;
$$;

create or replace function public.portal_support_reply(p_slug text, p_request uuid, p_body text)
 returns void
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  v public.portal_accounts%rowtype := private.portal_me(p_slug);
  v_body text := private.clean_text(p_body, 4000, 'Message');
begin
  perform private.portal_require_feature(v.company_id, 'support');
  if length(v_body) = 0 then
    raise exception 'Enter a message.' using errcode = '22023';
  end if;
  if not exists (select 1 from public.portal_support_requests where id = p_request and company_id = v.company_id and customer_id = v.customer_id) then
    raise exception 'Request not found.' using errcode = 'P0002';
  end if;
  perform private.portal_rate(v.id, 'support_reply', 50);
  insert into public.portal_messages (company_id, request_id, author_kind, author_id, body) values (v.company_id, p_request, 'customer', auth.uid(), v_body);
  update public.portal_support_requests set status = 'open', updated_at = now() where id = p_request;
end;
$$;

drop function if exists public.portal_support_open(text, text, text, text, uuid, uuid, uuid);
drop function if exists public.portal_support_send(text, uuid, text);
drop function if exists public.portal_support_link_options(text);
drop function if exists public.portal_support_file_begin(text, uuid, text, integer, text);
drop function if exists public.portal_support_file_path(text, uuid);
drop function if exists public.support_open_case(uuid, text, text, text, uuid, uuid, uuid, uuid);
drop function if exists public.support_reply(uuid, text, boolean, boolean);
drop function if exists public.support_update(uuid, text, uuid, uuid, uuid, uuid);
drop function if exists public.support_file_begin(uuid, text, integer, text);
drop function if exists public.support_file_path(uuid);
drop function if exists public.support_save_settings(integer);
drop function if exists public.support_overdue();
drop function if exists public.support_notice_recipients(uuid);
drop function if exists public.demo_support_samples();
drop function if exists private.support_file_reserve(uuid, uuid, uuid, text, integer, text);
drop function if exists private.support_check_links(uuid, uuid, uuid, uuid, uuid);
drop function if exists private.support_kind(text);
drop table if exists public.portal_support_files;
drop table if exists public.support_settings;

-- portal_messages is append-only; lift the guard only for this cleanup.
alter table public.portal_messages disable trigger portal_messages_append_only;
delete from public.portal_messages where internal;
delete from public.portal_support_requests where account_id is null;
alter table public.portal_messages enable trigger portal_messages_append_only;
alter table public.portal_messages drop constraint if exists portal_messages_internal_staff;
alter table public.portal_messages drop column if exists internal;

drop index if exists public.portal_support_requests_open;
alter table public.portal_support_requests drop constraint if exists portal_support_requests_opener;
alter table public.portal_support_requests drop constraint if exists portal_support_requests_ticket_fkey;
alter table public.portal_support_requests drop constraint if exists portal_support_requests_invoice_fkey;
alter table public.portal_support_requests drop column if exists kind, drop column if exists assigned_to, drop column if exists ticket_id,
  drop column if exists invoice_id, drop column if exists opened_by_staff, drop column if exists first_reply_at, drop column if exists closed_at;
alter table public.portal_support_requests alter column account_id set not null;

commit;
