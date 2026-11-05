-- =============================================================================
-- Outreach (owner 2026-11-05, master plan B139): the platform team finds trucking and hauling companies, prepares a
-- personal email with an FAQ, sends it from their own mailbox, and turns replies into leads.
--
--   private.outreach_prospects     companies to reach: from the FMCSA Company Census export (public registration data,
--                                  including the email the carrier gave FMCSA) or added by hand. One row per email.
--   private.outreach_suppressions  addresses never to contact again (unsubscribed, asked, bounced). Checked on import,
--                                  on add and before an email is prepared; never removed by the app.
--   private.outreach_events        what happened to each prospect (imported, email prepared, marked sent, replied...).
--   private.outreach_settings      one row: sender name, reply-to address, the postal address every commercial email
--                                  must carry (CAN-SPAM), and the email template with its FAQ.
--
-- Nothing is sent by Taviron: the person opens the prepared email in their own mail program and sends it themselves
-- (owner 2026-11-05: no outside services switched on before launch). Every email carries an unsubscribe link
-- (/unsubscribe/<token>); outreach_unsubscribe is called by that page through the service role only.
-- Platform team only (private.require_platform_admin); no company data is involved.
-- Rollback: supabase/rollbacks/20261120007500_outreach.down.sql
-- =============================================================================

create table private.outreach_prospects (
  id                 uuid primary key default gen_random_uuid(),
  email              text not null check (email = lower(email) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' and length(email) <= 254),
  company_name       text not null check (length(trim(company_name)) between 1 and 160),
  contact_name       text not null default '' check (length(contact_name) <= 120),
  phone              text not null default '' check (length(phone) <= 40),
  city               text not null default '' check (length(city) <= 80),
  state              text not null default '' check (length(state) <= 2),
  dot_number         text not null default '' check (dot_number ~ '^[0-9]{0,10}$'),
  power_units        integer check (power_units between 0 and 100000),
  drivers            integer check (drivers between 0 and 100000),
  segment            text not null default 'other' check (segment in ('aggregate', 'freight', 'other')),
  source             text not null default 'manual' check (source in ('fmcsa_census', 'csv', 'manual')),
  status             text not null default 'new'
                     check (status in ('new', 'contacted', 'replied', 'interested', 'not_interested', 'do_not_contact')),
  notes              text not null default '' check (length(notes) <= 2000),
  unsubscribe_token  text not null unique default replace(gen_random_uuid()::text, '-', ''),
  lead_id            uuid references private.leads (id) on delete set null,
  last_contacted_at  timestamptz,
  created_by         uuid references auth.users (id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (email)
);
create index outreach_prospects_list on private.outreach_prospects (status, created_at desc);
create index outreach_prospects_state on private.outreach_prospects (state, segment);

create table private.outreach_suppressions (
  email       text primary key check (email = lower(email) and length(email) <= 254),
  reason      text not null check (reason in ('unsubscribed', 'asked', 'bounced', 'manual')),
  created_at  timestamptz not null default now()
);

create table private.outreach_events (
  id           bigint generated always as identity primary key,
  prospect_id  uuid not null references private.outreach_prospects (id) on delete cascade,
  actor_id     uuid,
  action       text not null check (action in ('imported', 'added', 'prepared', 'marked_sent', 'status_changed', 'note_changed', 'unsubscribed', 'converted')),
  detail       jsonb not null default '{}'::jsonb,
  occurred_at  timestamptz not null default clock_timestamp()
);
create index outreach_events_prospect on private.outreach_events (prospect_id, occurred_at);

create table private.outreach_settings (
  id              boolean primary key default true check (id),
  sender_name     text not null default '' check (length(sender_name) <= 120),
  reply_to        text not null default '' check (length(reply_to) <= 254),
  postal_address  text not null default '' check (length(postal_address) <= 300),
  subject         text not null default '' check (length(subject) <= 200),
  body            text not null default '' check (length(body) <= 8000),
  faq             jsonb not null default '[]'::jsonb check (jsonb_typeof(faq) = 'array'),
  updated_by      uuid references auth.users (id) on delete set null,
  updated_at      timestamptz not null default now()
);
insert into private.outreach_settings (id) values (true) on conflict do nothing;

alter table private.outreach_prospects enable row level security;
alter table private.outreach_suppressions enable row level security;
alter table private.outreach_events enable row level security;
alter table private.outreach_settings enable row level security;
revoke all on private.outreach_prospects, private.outreach_suppressions, private.outreach_events, private.outreach_settings
  from public, anon, authenticated;

-- Normalized text helper for imports: trimmed, capped, never null.
create or replace function private.outreach_text(p jsonb, k text, n integer)
returns text
language sql
immutable
set search_path = ''
as $$ select left(trim(coalesce(p ->> k, '')), n) $$;

create or replace function private.outreach_int(p jsonb, k text)
returns integer
language sql
immutable
set search_path = ''
as $$ select case when trim(coalesce(p ->> k, '')) ~ '^[0-9]{1,6}$' then (trim(p ->> k))::integer end $$;

-- The prospect as the admin pages see it.
create or replace function private.outreach_json(r private.outreach_prospects)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object('id', r.id, 'email', r.email, 'company_name', r.company_name, 'contact_name', r.contact_name,
    'phone', r.phone, 'city', r.city, 'state', r.state, 'dot_number', r.dot_number, 'power_units', r.power_units,
    'drivers', r.drivers, 'segment', r.segment, 'source', r.source, 'status', r.status, 'notes', r.notes,
    'unsubscribe_token', r.unsubscribe_token, 'lead_id', r.lead_id, 'last_contacted_at', r.last_contacted_at,
    'created_at', r.created_at,
    'suppressed', exists (select 1 from private.outreach_suppressions s where s.email = r.email))
$$;

-- List with filters and the counts per status (platform team).
create or replace function public.platform_outreach_list(p_search text, p_status text, p_state text, p_segment text,
  p_min_units integer, p_max_units integer, p_limit integer default 100, p_offset integer default 0)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_q text := nullif(trim(coalesce(p_search, '')), '');
  v_rows jsonb;
  v_total integer;
  v_counts jsonb;
begin
  perform private.require_platform_admin();
  with f as (
    select p.* from private.outreach_prospects p
    where (nullif(p_status, '') is null or p.status = p_status)
      and (nullif(p_state, '') is null or p.state = upper(p_state))
      and (nullif(p_segment, '') is null or p.segment = p_segment)
      and (p_min_units is null or coalesce(p.power_units, 0) >= p_min_units)
      and (p_max_units is null or coalesce(p.power_units, 0) <= p_max_units)
      and (v_q is null or p.company_name ilike '%' || v_q || '%' or p.email ilike '%' || v_q || '%'
           or p.contact_name ilike '%' || v_q || '%' or p.city ilike '%' || v_q || '%' or p.dot_number = v_q)
  )
  select (select count(*) from f),
         coalesce((select jsonb_agg(private.outreach_json(x) order by (x.status = 'new') desc, x.power_units desc nulls last, x.company_name)
                   from (select * from f order by (status = 'new') desc, power_units desc nulls last, company_name
                         limit least(greatest(coalesce(p_limit, 100), 1), 500) offset greatest(coalesce(p_offset, 0), 0)) x), '[]')
    into v_total, v_rows;
  select coalesce(jsonb_object_agg(status, n), '{}') into v_counts
    from (select status, count(*) n from private.outreach_prospects group by status) c;
  return jsonb_build_object('total', v_total, 'rows', v_rows, 'counts', v_counts);
end;
$$;

create or replace function public.platform_outreach_get(p_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  r private.outreach_prospects%rowtype;
begin
  perform private.require_platform_admin();
  select * into r from private.outreach_prospects where id = p_id;
  if not found then
    raise exception 'Prospect not found.' using errcode = 'P0002';
  end if;
  return private.outreach_json(r) || jsonb_build_object('events',
    coalesce((select jsonb_agg(jsonb_build_object('action', e.action, 'detail', e.detail, 'occurred_at', e.occurred_at,
                'actor', coalesce(nullif(pr.full_name, ''), pr.email)) order by e.occurred_at desc)
              from private.outreach_events e left join public.profiles pr on pr.id = e.actor_id where e.prospect_id = p_id), '[]'));
end;
$$;

-- Add or refresh prospects (up to 1000 per call). An existing prospect keeps its status, notes and history; only empty
-- details are filled in. Suppressed addresses and rows without a valid email or company name are skipped.
create or replace function public.platform_outreach_import(p_rows jsonb, p_source text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r jsonb;
  v_email text;
  v_company text;
  v_id uuid;
  v_added integer := 0;
  v_updated integer := 0;
  v_suppressed integer := 0;
  v_invalid integer := 0;
  v_seg text;
begin
  perform private.require_platform_admin();
  if p_source not in ('fmcsa_census', 'csv', 'manual') then
    raise exception 'Unknown source.' using errcode = '22023';
  end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 1000 then
    raise exception 'Send at most 1000 rows at a time.' using errcode = '22023';
  end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    v_email := lower(private.outreach_text(r, 'email', 254));
    v_company := private.outreach_text(r, 'company_name', 160);
    v_seg := coalesce(nullif(r ->> 'segment', ''), 'other');
    if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or v_company = '' or v_seg not in ('aggregate', 'freight', 'other') then
      v_invalid := v_invalid + 1;
      continue;
    end if;
    if exists (select 1 from private.outreach_suppressions where email = v_email) then
      v_suppressed := v_suppressed + 1;
      continue;
    end if;
    select id into v_id from private.outreach_prospects where email = v_email;
    if v_id is null then
      insert into private.outreach_prospects (email, company_name, contact_name, phone, city, state, dot_number, power_units, drivers, segment, source, created_by)
      values (v_email, v_company, private.outreach_text(r, 'contact_name', 120), private.outreach_text(r, 'phone', 40),
              private.outreach_text(r, 'city', 80), upper(left(private.outreach_text(r, 'state', 2), 2)),
              coalesce(substring(private.outreach_text(r, 'dot_number', 10) from '^[0-9]{1,10}$'), ''),
              private.outreach_int(r, 'power_units'), private.outreach_int(r, 'drivers'), v_seg, p_source, auth.uid())
      returning id into v_id;
      insert into private.outreach_events (prospect_id, actor_id, action, detail) values (v_id, auth.uid(), case when p_source = 'manual' then 'added' else 'imported' end, jsonb_build_object('source', p_source));
      v_added := v_added + 1;
    else
      update private.outreach_prospects p set
        contact_name = case when p.contact_name = '' then private.outreach_text(r, 'contact_name', 120) else p.contact_name end,
        phone = case when p.phone = '' then private.outreach_text(r, 'phone', 40) else p.phone end,
        city = case when p.city = '' then private.outreach_text(r, 'city', 80) else p.city end,
        state = case when p.state = '' then upper(left(private.outreach_text(r, 'state', 2), 2)) else p.state end,
        dot_number = case when p.dot_number = '' then coalesce(substring(private.outreach_text(r, 'dot_number', 10) from '^[0-9]{1,10}$'), '') else p.dot_number end,
        power_units = coalesce(p.power_units, private.outreach_int(r, 'power_units')),
        drivers = coalesce(p.drivers, private.outreach_int(r, 'drivers')),
        segment = case when p.segment = 'other' then v_seg else p.segment end,
        updated_at = now()
      where p.id = v_id;
      v_updated := v_updated + 1;
    end if;
    v_id := null;
  end loop;
  return jsonb_build_object('added', v_added, 'updated', v_updated, 'suppressed', v_suppressed, 'invalid', v_invalid);
end;
$$;

-- An email was prepared (opened in the person's mail program) or marked as sent by them.
create or replace function public.platform_outreach_record(p_id uuid, p_action text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r private.outreach_prospects%rowtype;
begin
  perform private.require_platform_admin();
  if p_action not in ('prepared', 'marked_sent') then
    raise exception 'Unknown action.' using errcode = '22023';
  end if;
  select * into r from private.outreach_prospects where id = p_id for update;
  if not found then
    raise exception 'Prospect not found.' using errcode = 'P0002';
  end if;
  if r.status = 'do_not_contact' or exists (select 1 from private.outreach_suppressions where email = r.email) then
    raise exception 'This company asked not to be contacted.' using errcode = '42501';
  end if;
  if p_action = 'marked_sent' then
    update private.outreach_prospects set status = case when status = 'new' then 'contacted' else status end,
           last_contacted_at = now(), updated_at = now() where id = p_id;
  end if;
  insert into private.outreach_events (prospect_id, actor_id, action) values (p_id, auth.uid(), p_action);
  return jsonb_build_object('ok', true);
end;
$$;

-- Status and notes. 'do_not_contact' also adds the address to the suppression list, permanently.
create or replace function public.platform_outreach_update(p_id uuid, p_status text, p_notes text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r private.outreach_prospects%rowtype;
begin
  perform private.require_platform_admin();
  select * into r from private.outreach_prospects where id = p_id for update;
  if not found then
    raise exception 'Prospect not found.' using errcode = 'P0002';
  end if;
  if p_status is not null and p_status not in ('new', 'contacted', 'replied', 'interested', 'not_interested', 'do_not_contact') then
    raise exception 'Unknown status.' using errcode = '22023';
  end if;
  if r.status = 'do_not_contact' and p_status is not null and p_status <> 'do_not_contact' then
    raise exception 'This company asked not to be contacted; that cannot be undone here.' using errcode = '42501';
  end if;
  if p_notes is not null and length(p_notes) > 2000 then
    raise exception 'Notes are at most 2000 characters.' using errcode = '22023';
  end if;
  if p_status is not null and p_status <> r.status then
    update private.outreach_prospects set status = p_status, updated_at = now() where id = p_id;
    insert into private.outreach_events (prospect_id, actor_id, action, detail)
    values (p_id, auth.uid(), 'status_changed', jsonb_build_object('from', r.status, 'to', p_status));
    if p_status = 'do_not_contact' then
      insert into private.outreach_suppressions (email, reason) values (r.email, 'asked') on conflict (email) do nothing;
    end if;
  end if;
  if p_notes is not null and p_notes <> r.notes then
    update private.outreach_prospects set notes = p_notes, updated_at = now() where id = p_id;
    insert into private.outreach_events (prospect_id, actor_id, action) values (p_id, auth.uid(), 'note_changed');
  end if;
  return jsonb_build_object('ok', true);
end;
$$;

-- An interested prospect becomes a lead in the Leads workspace (once).
create or replace function public.platform_outreach_convert(p_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  r private.outreach_prospects%rowtype;
  v_lead uuid;
begin
  perform private.require_platform_admin();
  select * into r from private.outreach_prospects where id = p_id for update;
  if not found then
    raise exception 'Prospect not found.' using errcode = 'P0002';
  end if;
  if r.lead_id is not null then
    return r.lead_id;
  end if;
  if r.status = 'do_not_contact' then
    raise exception 'This company asked not to be contacted.' using errcode = '42501';
  end if;
  insert into private.leads (kind, status, name, email, company_name, phone, truck_count, message, source_path, owner_id)
  values ('contact', 'contacted', left(coalesce(nullif(r.contact_name, ''), r.company_name), 120), r.email, r.company_name, r.phone,
          r.power_units, left('From outreach' || case when r.notes <> '' then ': ' || r.notes else '.' end, 4000), '/admin/outreach', auth.uid())
  returning id into v_lead;
  insert into private.lead_events (lead_id, actor_id, action, detail) values (v_lead, auth.uid(), 'submitted', jsonb_build_object('source', 'outreach'));
  update private.outreach_prospects set lead_id = v_lead, status = case when status in ('new', 'contacted', 'replied') then 'interested' else status end,
         updated_at = now() where id = p_id;
  insert into private.outreach_events (prospect_id, actor_id, action, detail) values (p_id, auth.uid(), 'converted', jsonb_build_object('lead_id', v_lead));
  return v_lead;
end;
$$;

create or replace function public.platform_outreach_settings()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_platform_admin();
  return (select jsonb_build_object('sender_name', s.sender_name, 'reply_to', s.reply_to, 'postal_address', s.postal_address,
            'subject', s.subject, 'body', s.body, 'faq', s.faq, 'updated_at', s.updated_at)
          from private.outreach_settings s);
end;
$$;

create or replace function public.platform_outreach_settings_save(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_faq jsonb := coalesce(p -> 'faq', '[]'::jsonb);
  v_reply text := lower(trim(coalesce(p ->> 'reply_to', '')));
begin
  perform private.require_platform_admin();
  if jsonb_typeof(v_faq) <> 'array' or jsonb_array_length(v_faq) > 12 then
    raise exception 'Up to 12 questions.' using errcode = '22023';
  end if;
  if v_reply <> '' and v_reply !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'Enter a valid reply-to email.' using errcode = '22023';
  end if;
  if length(coalesce(p ->> 'body', '')) > 8000 or length(coalesce(p ->> 'subject', '')) > 200
     or length(coalesce(p ->> 'postal_address', '')) > 300 or length(coalesce(p ->> 'sender_name', '')) > 120 then
    raise exception 'A field is too long.' using errcode = '22023';
  end if;
  update private.outreach_settings set
    sender_name = trim(coalesce(p ->> 'sender_name', '')), reply_to = v_reply, postal_address = trim(coalesce(p ->> 'postal_address', '')),
    subject = trim(coalesce(p ->> 'subject', '')), body = coalesce(p ->> 'body', ''), faq = v_faq,
    updated_by = auth.uid(), updated_at = now()
  where id;
  return jsonb_build_object('ok', true);
end;
$$;

-- The unsubscribe page (service role only, after the person confirms): the address is never contacted again.
create or replace function public.outreach_unsubscribe(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r private.outreach_prospects%rowtype;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{32}$' then
    return jsonb_build_object('ok', false);
  end if;
  select * into r from private.outreach_prospects where unsubscribe_token = p_token for update;
  if not found then
    return jsonb_build_object('ok', false);
  end if;
  insert into private.outreach_suppressions (email, reason) values (r.email, 'unsubscribed') on conflict (email) do nothing;
  if r.status <> 'do_not_contact' then
    update private.outreach_prospects set status = 'do_not_contact', updated_at = now() where id = r.id;
    insert into private.outreach_events (prospect_id, action) values (r.id, 'unsubscribed');
  end if;
  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function private.outreach_text(jsonb, text, integer), private.outreach_int(jsonb, text),
  private.outreach_json(private.outreach_prospects) from public, anon, authenticated;
revoke all on function public.platform_outreach_list(text, text, text, text, integer, integer, integer, integer),
  public.platform_outreach_get(uuid), public.platform_outreach_import(jsonb, text), public.platform_outreach_record(uuid, text),
  public.platform_outreach_update(uuid, text, text), public.platform_outreach_convert(uuid), public.platform_outreach_settings(),
  public.platform_outreach_settings_save(jsonb), public.outreach_unsubscribe(text) from public, anon, authenticated;
grant execute on function public.platform_outreach_list(text, text, text, text, integer, integer, integer, integer),
  public.platform_outreach_get(uuid), public.platform_outreach_import(jsonb, text), public.platform_outreach_record(uuid, text),
  public.platform_outreach_update(uuid, text, text), public.platform_outreach_convert(uuid), public.platform_outreach_settings(),
  public.platform_outreach_settings_save(jsonb) to authenticated;
grant execute on function public.outreach_unsubscribe(text) to service_role;
