-- =============================================================================
-- "Mistake on my ticket": a driver tells the office that a ticket they already sent is wrong (owner decision
-- 2026-11-14 to 11-17, master plan §12 TM1).
--
-- From the phone the driver picks one of their own sent tickets, says what is wrong (the ticket number, the quantity,
-- the material, or something else), gives the correct value and a note, and may add one photo. The report goes to the
-- office's ticket review (the review queue and the ticket's own page), never to dispatch as "can't complete". The
-- office corrects the ticket with the existing correction flow (a new revision); the report is then marked handled by
-- itself, or the reviewer marks it handled with a note. The driver never edits the ticket.
--
--   * public.ticket_mistake_reports: one row per report. Read by people who see tickets (tickets.view) in the company,
--     and by the driver who sent it (their own only). Written only through the functions below.
--   * public.ticket_mistake_report(payload): the driver's own sent ticket only (driver.portal, linked active driver,
--     ticket driven by them, not voided or replaced), idempotent on the phone's submission key (the offline outbox sends
--     it again until it is in), audited on the ticket's order.
--   * public.ticket_mistake_photo_begin(report, mime, size): one photo, within the hour, by the driver who sent it;
--     reserves the storage path (private field-report-photos bucket; the app stores the bytes with the service role).
--     public.ticket_mistake_photo_path(report): the path for someone who may read the report.
--   * public.ticket_mistake_resolve(report, note): tickets.review; audited.
--   * private.ticket_mistake_corrected: a correction of the ticket (a new revision) marks its open reports handled.
--   * driver_portal_home and private.driver_assignments also return each ticket's paper ticket number
--     (external_reference), so the driver's load card shows it after sending, and whether a mistake is reported.
--
--   * public.demo_ticket_mistake_sample(): one fictional open report in a demo company (demo owner only).
-- Additive (a table, functions, a trigger; two read functions gain fields). Works with the code before and after it.
-- Reversible: supabase/rollbacks/20261120024720_ticket_mistake_report.down.sql
-- =============================================================================

create table if not exists public.ticket_mistake_reports (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies (id),
  ticket_id       uuid not null,
  ticket_number   text not null,
  driver_id       uuid not null,
  field           text not null check (field in ('ticket_number', 'quantity', 'material', 'other')),
  correct_value   text not null default '' check (length(correct_value) <= 200),
  note            text not null default '' check (length(note) <= 1000),
  photo_path      text,
  photo_mime      text,
  submission_key  uuid,
  status          text not null default 'open' check (status in ('open', 'resolved')),
  reported_by     uuid references auth.users (id) on delete set null,
  created_at      timestamptz not null default now(),
  resolved_by     uuid references auth.users (id) on delete set null,
  resolved_at     timestamptz,
  resolution_note text not null default '' check (length(resolution_note) <= 500),
  unique (company_id, id),
  foreign key (company_id, ticket_id) references public.delivery_tickets (company_id, id) on delete cascade,
  foreign key (company_id, driver_id) references public.drivers (company_id, id) on delete cascade,
  constraint ticket_mistake_reports_said check (length(trim(correct_value)) > 0 or length(trim(note)) > 0),
  constraint ticket_mistake_reports_status check ((status = 'open' and resolved_at is null) or (status = 'resolved' and resolved_at is not null))
);

create unique index if not exists ticket_mistake_reports_submission on public.ticket_mistake_reports (company_id, submission_key) where submission_key is not null;
create index if not exists ticket_mistake_reports_open on public.ticket_mistake_reports (company_id, status, created_at);
create index if not exists ticket_mistake_reports_ticket on public.ticket_mistake_reports (company_id, ticket_number);
create index if not exists ticket_mistake_reports_driver on public.ticket_mistake_reports (company_id, driver_id, created_at desc);

alter table public.ticket_mistake_reports enable row level security;
revoke all on public.ticket_mistake_reports from anon, authenticated;
grant select on public.ticket_mistake_reports to authenticated;

drop policy if exists ticket_mistake_reports_office on public.ticket_mistake_reports;
create policy ticket_mistake_reports_office on public.ticket_mistake_reports for select to authenticated
  using (company_id = (select private.current_company_id()) and (select private.has_permission('tickets.view')));
drop policy if exists ticket_mistake_reports_driver on public.ticket_mistake_reports;
create policy ticket_mistake_reports_driver on public.ticket_mistake_reports for select to authenticated
  using (company_id = (select private.current_company_id()) and driver_id = (select private.my_driver_id()));

-- The company guard every business table has (a row never moves to another company).
drop trigger if exists a_company_guard on public.ticket_mistake_reports;
create trigger a_company_guard before update on public.ticket_mistake_reports
  for each row execute function private.forbid_company_change();

-- -----------------------------------------------------------------------------
-- The driver's report
-- -----------------------------------------------------------------------------
create or replace function public.ticket_mistake_report(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_d      public.drivers%rowtype := private.portal_driver();
  v_key    uuid;
  v_ticket public.delivery_tickets%rowtype;
  v_field  text := coalesce(p_payload ->> 'field', '');
  v_value  text := private.clean_text(coalesce(p_payload ->> 'correct_value', ''), 200, 'Correct value');
  v_note   text := private.clean_text(coalesce(p_payload ->> 'note', ''), 1000, 'Note');
  v_id     uuid;
begin
  begin
    v_key := nullif(p_payload ->> 'submission_key', '')::uuid;
    v_ticket.id := (p_payload ->> 'ticket_id')::uuid;
  exception when others then
    raise exception 'Choose the ticket.' using errcode = '22023';
  end;
  -- Sent again from the phone's outbox: the same report, recorded once.
  if v_key is not null then
    select id into v_id from public.ticket_mistake_reports where company_id = v_d.company_id and submission_key = v_key;
    if found then
      return jsonb_build_object('report_id', v_id, 'created', false);
    end if;
  end if;
  select * into v_ticket from public.delivery_tickets
   where id = v_ticket.id and company_id = v_d.company_id and driver_id = v_d.id;
  if not found then
    raise exception 'That ticket is not one of yours.' using errcode = '42501';
  end if;
  if v_ticket.status in ('voided', 'superseded') then
    raise exception 'That ticket was already replaced or voided by the office. Call the office if it is still wrong.' using errcode = '22023';
  end if;
  if v_field not in ('ticket_number', 'quantity', 'material', 'other') then
    raise exception 'Choose what is wrong: the ticket number, the quantity, the material or something else.' using errcode = '22023';
  end if;
  if length(v_value) = 0 and length(v_note) = 0 then
    raise exception 'Say what is correct, or add a note for the office.' using errcode = '22023';
  end if;
  insert into public.ticket_mistake_reports (company_id, ticket_id, ticket_number, driver_id, field, correct_value, note, submission_key, reported_by)
  values (v_d.company_id, v_ticket.id, v_ticket.ticket_number, v_d.id, v_field, v_value, v_note, v_key, auth.uid())
  returning id into v_id;
  perform private.log_event('ticket.mistake_reported', 'order', v_ticket.order_id,
    format('Driver reported a mistake on ticket %s (%s)', v_ticket.ticket_number,
           case v_field when 'ticket_number' then 'ticket number' when 'quantity' then 'quantity' when 'material' then 'material' else 'other' end),
    jsonb_build_object('report_id', v_id, 'ticket_id', v_ticket.id, 'field', v_field));
  return jsonb_build_object('report_id', v_id, 'created', true);
end;
$$;

create or replace function public.ticket_mistake_photo_begin(p_report uuid, p_mime text, p_size integer)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_d    public.drivers%rowtype := private.portal_driver();
  v_r    public.ticket_mistake_reports%rowtype;
  v_path text;
begin
  select * into v_r from public.ticket_mistake_reports
   where id = p_report and company_id = v_d.company_id and driver_id = v_d.id and reported_by = auth.uid()
   for update;
  if not found then
    raise exception 'Report not found.' using errcode = 'P0002';
  end if;
  if v_r.created_at < now() - interval '1 hour' then
    raise exception 'A photo can be added for an hour after the report is sent. Show it to the office.' using errcode = '22023';
  end if;
  if p_mime is null or p_mime not in ('image/jpeg', 'image/png', 'image/webp') or p_size is null or p_size < 1 or p_size > 5242880 then
    raise exception 'Photos must be JPEG, PNG or WebP and at most 5 MB.' using errcode = '22023';
  end if;
  if v_r.photo_path is not null then
    raise exception 'This report already has its photo.' using errcode = '22023';
  end if;
  v_path := format('%s/ticket-mistakes/%s.%s', v_r.company_id, gen_random_uuid(),
                   case p_mime when 'image/png' then 'png' when 'image/webp' then 'webp' else 'jpg' end);
  update public.ticket_mistake_reports set photo_path = v_path, photo_mime = p_mime where id = v_r.id;
  return v_path;
end;
$$;

-- The photo's path for someone who may read the report (row rules: tickets.view, or the driver who sent it).
create or replace function public.ticket_mistake_photo_path(p_report uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v_driver uuid := private.my_driver_id();
  v_path text;
begin
  select r.photo_path into v_path from public.ticket_mistake_reports r
   where r.id = p_report and r.company_id = v_company
     and (private.has_permission('tickets.view') or (v_driver is not null and r.driver_id = v_driver));
  return v_path;
end;
$$;

-- -----------------------------------------------------------------------------
-- The office
-- -----------------------------------------------------------------------------
create or replace function public.ticket_mistake_resolve(p_report uuid, p_note text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v_note text := private.clean_text(coalesce(p_note, ''), 500, 'Note');
  v_r public.ticket_mistake_reports%rowtype;
  v_order uuid;
begin
  perform private.require_permission('tickets.review');
  select * into v_r from public.ticket_mistake_reports where id = p_report and company_id = v_company for update;
  if not found then
    raise exception 'Report not found.' using errcode = 'P0002';
  end if;
  if v_r.status = 'resolved' then
    return;
  end if;
  if length(v_note) = 0 then
    raise exception 'Say what you did, for example "Corrected the quantity" or "The ticket was right".' using errcode = '22023';
  end if;
  update public.ticket_mistake_reports set status = 'resolved', resolved_by = auth.uid(), resolved_at = now(), resolution_note = v_note
   where id = v_r.id;
  select order_id into v_order from public.delivery_tickets where id = v_r.ticket_id and company_id = v_company;
  perform private.log_event('ticket.mistake_handled', 'order', v_order,
    format('Driver report on ticket %s handled: %s', v_r.ticket_number, v_note), jsonb_build_object('report_id', v_r.id));
end;
$$;

-- A correction (a new revision of the ticket) handles its open reports.
create or replace function private.ticket_mistake_corrected()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.supersedes_id is not null then
    update public.ticket_mistake_reports
       set status = 'resolved', resolved_by = auth.uid(), resolved_at = now(),
           resolution_note = format('Ticket corrected (revision %s).', new.revision)
     where company_id = new.company_id and ticket_number = new.ticket_number and status = 'open';
  end if;
  return new;
end;
$$;

revoke all on function private.ticket_mistake_corrected() from public, anon, authenticated;
drop trigger if exists ticket_mistake_corrected on public.delivery_tickets;
create trigger ticket_mistake_corrected after insert on public.delivery_tickets
  for each row execute function private.ticket_mistake_corrected();

revoke all on function public.ticket_mistake_report(jsonb), public.ticket_mistake_photo_begin(uuid, text, integer),
  public.ticket_mistake_photo_path(uuid), public.ticket_mistake_resolve(uuid, text) from public, anon;
grant execute on function public.ticket_mistake_report(jsonb), public.ticket_mistake_photo_begin(uuid, text, integer),
  public.ticket_mistake_photo_path(uuid), public.ticket_mistake_resolve(uuid, text) to authenticated;

-- -----------------------------------------------------------------------------
-- Demo sample: one open report, so the review queue, the ticket and the driver's phone show it
-- -----------------------------------------------------------------------------
-- Only the active owner of an active demo company (private.demo_owner_company(); real companies are refused, 42501).
-- On a live ticket of the driver linked to the demo owner (the Driver preview then shows "Mistake reported"), else of any
-- demo driver; fictional, marked "(demo)"; added once (a demo that has any report gets none). Nothing is sent.
create or replace function public.demo_ticket_mistake_sample()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_demo uuid := private.demo_owner_company();
  v_t public.delivery_tickets%rowtype;
begin
  if v_demo is null then
    raise exception 'Demo samples are only added to a demo company, by its owner.' using errcode = '42501';
  end if;
  if exists (select 1 from public.ticket_mistake_reports where company_id = v_demo) then
    return 0;
  end if;
  select t.* into v_t from public.delivery_tickets t
    left join public.drivers d on d.id = t.driver_id and d.company_id = t.company_id
   where t.company_id = v_demo and t.driver_id is not null and t.status in ('submitted', 'needs_review', 'accepted')
   order by (d.user_id is not distinct from auth.uid()) desc, t.created_at desc
   limit 1;
  if not found then
    return 0;
  end if;
  insert into public.ticket_mistake_reports (company_id, ticket_id, ticket_number, driver_id, field, correct_value, note, reported_by)
  values (v_demo, v_t.id, v_t.ticket_number, v_t.driver_id, 'quantity', trim(to_char(v_t.quantity + 0.5, 'FM999990.0##')),
          'Scale ticket says half a unit more than I typed (demo).', null);
  return 1;
end;
$$;

revoke all on function public.demo_ticket_mistake_sample() from public, anon;
grant execute on function public.demo_ticket_mistake_sample() to authenticated;

-- -----------------------------------------------------------------------------
-- The paper ticket number on the driver's load card and ticket list
-- -----------------------------------------------------------------------------
do $$
declare
  r record;
  v_def text;
begin
  for r in select * from (values
      ('private.driver_assignments(uuid, uuid, date, date, uuid)'::regprocedure,
       $old$'quantity', t.quantity, 'unit_code', t.unit_code) order by t.ticket_number)$old$,
       $new$'quantity', t.quantity, 'unit_code', t.unit_code, 'paper_number', t.external_reference) order by t.ticket_number)$new$),
      ('public.driver_portal_home()'::regprocedure,
       $old$'review_reasons', to_jsonb(t.review_reasons)) order by t.created_at desc)$old$,
       $new$'review_reasons', to_jsonb(t.review_reasons), 'paper_number', t.external_reference,
                                          'mistake_reported', exists (select 1 from public.ticket_mistake_reports m
                                                                       where m.company_id = t.company_id and m.ticket_number = t.ticket_number
                                                                         and m.driver_id = v_d.id and m.status = 'open')) order by t.created_at desc)$new$)) as t(fn, old_text, new_text)
  loop
    v_def := pg_get_functiondef(r.fn);
    if (length(v_def) - length(replace(v_def, r.old_text, ''))) / length(r.old_text) <> 1 then
      raise exception 'The ticket list of % is not as expected; nothing was changed.', r.fn;
    end if;
    execute replace(v_def, r.old_text, r.new_text);
  end loop;
end;
$$;

notify pgrst, 'reload schema';

-- Verification
do $$
begin
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where (n.nspname, p.proname) in (('public', 'ticket_mistake_report'), ('public', 'ticket_mistake_photo_begin'),
                                     ('public', 'ticket_mistake_photo_path'), ('public', 'ticket_mistake_resolve'),
                                     ('private', 'ticket_mistake_corrected'), ('public', 'driver_portal_home'), ('private', 'driver_assignments'),
                                     ('public', 'demo_ticket_mistake_sample'))
      and not (p.prosecdef and coalesce(p.proconfig, '{}') @> array['search_path=""']))
  then
    raise exception 'A new or changed function is not a pinned security definer function.';
  end if;
  if has_table_privilege('authenticated', 'public.ticket_mistake_reports', 'insert')
     or has_table_privilege('authenticated', 'public.ticket_mistake_reports', 'update')
     or has_table_privilege('anon', 'public.ticket_mistake_reports', 'select') then
    raise exception 'Mistake reports are written through their functions only.';
  end if;
end;
$$;
