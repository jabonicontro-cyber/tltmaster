-- Support inbox (PC1, owner 2026-11-12). Requests customers send from Help (public.help_support_requests,
-- 20261120000400) could be read in the console but nothing changed their status. Now:
--   * Both staff levels (Admin and Support) read the inbox and one request with its notes: who sent it (name and the
--     email they sign in with, to answer them), the company, the page, the message, status and every note.
--   * Staff change the status (New, Answered, Closed) and add a note (internal) or a reply (the answer written for the
--     customer). A reply is a record only: nothing is emailed from here; the console offers to open it in the staff
--     member's own email program. Every change is in the platform audit log ('support_request_status',
--     'support_request_note', 'support_request_reply', with the company id), and the request records who handled it.
--   * The person who sent it keeps seeing its status in Help (their own rows, as before).
--   * public.platform_my_support_work(): for each staff member, their own support visits and the change requests they
--     asked owners to approve (private.support_sessions, private.support_change_requests), newest first.
-- No emails. Reversible: supabase/rollbacks/20261120020500_support_inbox.down.sql.

alter table public.help_support_requests add column updated_at timestamptz;
alter table public.help_support_requests add column handled_by uuid references auth.users (id) on delete set null;

-- Customers write and read their own requests by column (security review 2026-11-12, L1): they cannot set or read who
-- at Taviron handled a request or when it was last updated; those are written by the inbox functions below only.
revoke select, insert on public.help_support_requests from authenticated;
grant select (id, company_id, user_id, page, article_id, message, status, created_at) on public.help_support_requests to authenticated;
grant insert (company_id, user_id, page, article_id, message, status) on public.help_support_requests to authenticated;

create table private.help_support_notes (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  request_id uuid not null references public.help_support_requests (id) on delete cascade,
  author_id  uuid references auth.users (id) on delete set null,
  kind       text not null check (kind in ('note', 'reply')),
  body       text not null check (length(btrim(body)) between 1 and 4000),
  created_at timestamptz not null default clock_timestamp()
);
create index help_support_notes_request on private.help_support_notes (request_id, created_at);
alter table private.help_support_notes enable row level security;
revoke all on private.help_support_notes from public, anon, authenticated;

create or replace function public.platform_support_inbox(p_status text default '')
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_status text := coalesce(nullif(btrim(p_status), ''), 'open');
begin
  perform private.require_platform_staff();
  if v_status not in ('open', 'new', 'answered', 'closed', 'all') then
    raise exception 'Unknown status.' using errcode = '22023';
  end if;
  return jsonb_build_object(
    'counts', (select jsonb_build_object('new', count(*) filter (where r.status = 'new'), 'answered', count(*) filter (where r.status = 'answered'),
                                         'closed', count(*) filter (where r.status = 'closed'), 'all', count(*))
               from public.help_support_requests r),
    'items', coalesce((select jsonb_agg(to_jsonb(x) order by x.status = 'new' desc, x.created_at desc) from (
        select r.id, r.company_id, c.name as company, c.is_demo, private.company_stage(c.id) as stage,
               coalesce(private.person_name(r.user_id), 'Someone no longer at the company') as from_name,
               coalesce((select p.email from public.profiles p where p.id = r.user_id), '') as from_email,
               r.page, r.article_id, left(r.message, 600) as message, r.status, r.created_at, r.updated_at,
               (select count(*) from private.help_support_notes n where n.request_id = r.id) as notes,
               (select max(n.created_at) from private.help_support_notes n where n.request_id = r.id) as last_note_at,
               private.person_name(r.handled_by) as handled_by
        from public.help_support_requests r join public.companies c on c.id = r.company_id
        where case v_status when 'all' then true when 'open' then r.status in ('new', 'answered') else r.status = v_status end
        order by r.created_at desc limit 200) x), '[]'::jsonb));
end;
$$;
revoke all on function public.platform_support_inbox(text) from public, anon;
grant execute on function public.platform_support_inbox(text) to authenticated;

create or replace function public.platform_support_request(p_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v jsonb;
begin
  perform private.require_platform_staff();
  select jsonb_build_object(
           'id', r.id, 'company_id', r.company_id, 'company', c.name, 'is_demo', c.is_demo, 'stage', private.company_stage(c.id),
           'from_name', coalesce(private.person_name(r.user_id), 'Someone no longer at the company'),
           'from_email', coalesce((select p.email from public.profiles p where p.id = r.user_id), ''),
           'from_role', (select m.role from public.company_memberships m where m.company_id = r.company_id and m.user_id = r.user_id),
           'page', r.page, 'article_id', r.article_id, 'message', r.message, 'status', r.status,
           'created_at', r.created_at, 'updated_at', r.updated_at, 'handled_by', private.person_name(r.handled_by),
           'notes', coalesce((select jsonb_agg(jsonb_build_object('kind', n.kind, 'body', n.body, 'at', n.created_at,
                                                                  'author', coalesce(private.person_name(n.author_id), 'Taviron'))
                                               order by n.created_at)
                              from private.help_support_notes n where n.request_id = r.id), '[]'::jsonb))
    into v
  from public.help_support_requests r join public.companies c on c.id = r.company_id
  where r.id = p_id;
  if v is null then raise exception 'Request not found.' using errcode = 'P0002'; end if;
  return v;
end;
$$;
revoke all on function public.platform_support_request(uuid) from public, anon;
grant execute on function public.platform_support_request(uuid) to authenticated;

-- Change the status and/or add a note or a reply. p_status null or '' keeps the status; p_body '' adds nothing.
create or replace function public.platform_support_request_update(p_id uuid, p_status text, p_kind text, p_body text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := private.require_platform_staff();
  r public.help_support_requests%rowtype;
  v_status text := nullif(btrim(coalesce(p_status, '')), '');
  v_body text := btrim(coalesce(p_body, ''));
  v_kind text := coalesce(nullif(btrim(p_kind), ''), 'note');
  v_label text;
begin
  select * into r from public.help_support_requests where id = p_id for update;
  if not found then raise exception 'Request not found.' using errcode = 'P0002'; end if;
  if v_status is not null and v_status not in ('new', 'answered', 'closed') then
    raise exception 'Choose New, Answered or Closed.' using errcode = '22023';
  end if;
  if v_kind not in ('note', 'reply') then raise exception 'Unknown kind of note.' using errcode = '22023'; end if;
  if length(v_body) > 4000 then raise exception 'Keep it under 4000 characters.' using errcode = '22023'; end if;
  if (v_status is null or v_status = r.status) and v_body = '' then
    raise exception 'Nothing to save: change the status or write a note.' using errcode = '22023';
  end if;
  if v_body <> '' then
    insert into private.help_support_notes (company_id, request_id, author_id, kind, body) values (r.company_id, r.id, v_me, v_kind, v_body);
    perform private.platform_log(case v_kind when 'reply' then 'support_request_reply' else 'support_request_note' end,
      'support_request', r.id::text, left(v_body, 200), jsonb_build_object('company_id', r.company_id));
  end if;
  if v_status is not null and v_status <> r.status then
    v_label := case v_status when 'new' then 'New' when 'answered' then 'Answered' else 'Closed' end;
    perform private.platform_log('support_request_status', 'support_request', r.id::text, 'Marked ' || v_label,
      jsonb_build_object('company_id', r.company_id, 'from', r.status, 'to', v_status));
  end if;
  update public.help_support_requests
     set status = coalesce(v_status, status), updated_at = now(), handled_by = v_me
   where id = r.id;
end;
$$;
revoke all on function public.platform_support_request_update(uuid, text, text, text) from public, anon;
grant execute on function public.platform_support_request_update(uuid, text, text, text) to authenticated;

-- The signed-in staff member's own visits and change requests (never anyone else's).
create or replace function public.platform_my_support_work()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_me uuid := private.require_platform_staff();
begin
  return jsonb_build_object(
    'visits', coalesce((select jsonb_agg(to_jsonb(x) order by x.started_at desc) from (
        select s.id, s.company_id, c.name as company, c.is_demo, s.reason, s.started_at, s.ends_at,
               coalesce(s.ended_at, case when s.ends_at <= now() then s.ends_at end) as ended_at,
               case when s.ended_at is null and s.ends_at <= now() then 'expired' else s.end_reason end as end_reason,
               s.ended_at is null and s.ends_at > now() as open
        from private.support_sessions s join public.companies c on c.id = s.company_id
        where s.user_id = v_me order by s.started_at desc limit 50) x), '[]'::jsonb),
    'requests', coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at desc) from (
        select q.id, q.company_id, c.name as company, q.summary, q.note,
               case when q.status = 'pending' and q.expires_at <= now() then 'expired'
                    when q.status = 'running' and q.decided_at < now() - interval '15 minutes' then 'failed'
                    else q.status end as status,
               q.created_at, q.expires_at, q.decided_at, private.person_name(q.decided_by) as decided_by, q.result
        from private.support_change_requests q join public.companies c on c.id = q.company_id
        where q.requested_by = v_me order by q.created_at desc limit 50) x), '[]'::jsonb));
end;
$$;
revoke all on function public.platform_my_support_work() from public, anon;
grant execute on function public.platform_my_support_work() to authenticated;
