-- =============================================================================
-- Maintenance request triage (owner directive 2026-10-25).
--
-- public.work_order_triage keeps suggestions about a reported problem: the problem as reported, sentences quoted from
-- the report, symptoms, onset, whether it is worsening, open questions, a suggested category and urgency, whether a
-- safety review is needed and related open work orders. Each suggestion records where it came from: 'rules' (the
-- deterministic triage in src/lib/maintenance-triage.ts, always available) or 'ai' (only when the AI capability is
-- switched on and passed its evaluation; never required).
--
-- A person decides: accept (category and urgency are applied), edit (their own values are applied) or reject. A
-- safety review recommendation, when accepted, marks the work order safety-critical, which restricts the vehicle as
-- before; nothing here can clear a vehicle, lower an existing safety flag or record an inspection. The original report
-- (the work order's title and description) is never changed. Every decision is recorded in work_order_events.
--
-- Reversible: supabase/rollbacks/20261120003100_maintenance_triage.down.sql
-- =============================================================================

alter table public.work_order_events drop constraint work_order_events_kind_check;
alter table public.work_order_events add constraint work_order_events_kind_check check (kind in (
  'created', 'updated', 'status', 'assigned', 'scheduled', 'rescheduled', 'unscheduled', 'canceled',
  'inspection_started', 'inspection_failed', 'cleared', 'restricted', 'returned_to_service',
  'crew', 'time', 'task', 'triage'));

create table public.work_order_triage (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.companies (id),
  work_order_id  uuid not null,
  source         text not null check (source in ('rules', 'ai')),
  model          text not null default '' check (length(model) <= 80),
  suggestion     jsonb not null check (jsonb_typeof(suggestion) = 'object' and pg_column_size(suggestion) <= 16384),
  status         text not null default 'suggested' check (status in ('suggested', 'accepted', 'edited', 'rejected', 'superseded')),
  decided_by     uuid references auth.users (id) on delete set null,
  decided_at     timestamptz,
  decision       jsonb not null default '{}'::jsonb,
  decision_note  text not null default '' check (length(decision_note) <= 1000),
  created_by     uuid default auth.uid() references auth.users (id) on delete set null,
  created_at     timestamptz not null default now(),
  foreign key (company_id, work_order_id) references public.work_orders (company_id, id) on delete cascade,
  check ((status in ('suggested', 'superseded')) = (decided_at is null))
);
-- One open suggestion per work order: a new one supersedes the previous.
create unique index work_order_triage_one_open on public.work_order_triage (work_order_id) where status = 'suggested';
create index work_order_triage_wo on public.work_order_triage (company_id, work_order_id, created_at desc);

alter table public.work_order_triage enable row level security;
create policy work_order_triage_read on public.work_order_triage for select to authenticated
  using (company_id = (select private.current_company_id()) and (select private.has_permission('maintenance.view')));
revoke all on public.work_order_triage from anon;
grant select on public.work_order_triage to authenticated;

-- Store a suggestion (computed on the server) for a reported or triaged work order.
create or replace function public.maintenance_save_triage(p_wo uuid, p_source text, p_model text, p_suggestion jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_wo public.work_orders%rowtype := private.wo_for_crew(p_wo);
  v_id uuid;
begin
  if coalesce(p_source, '') not in ('rules', 'ai') then
    raise exception 'Unknown suggestion source.' using errcode = '22023';
  end if;
  -- Null-safe: a missing key must fail the check, not slip through as unknown.
  if coalesce(jsonb_typeof(p_suggestion), '') <> 'object'
     or coalesce(p_suggestion ->> 'category', '') not in ('preventive', 'repair', 'inspection', 'brakes', 'tires', 'engine', 'electrical', 'hydraulics', 'body', 'other')
     or coalesce(p_suggestion ->> 'urgency', '') not in ('low', 'normal', 'high', 'immediate')
     or coalesce(jsonb_typeof(p_suggestion -> 'safetyReview'), '') <> 'boolean' then
    raise exception 'The suggestion is incomplete.' using errcode = '22023';
  end if;
  update public.work_order_triage set status = 'superseded' where work_order_id = p_wo and status = 'suggested';
  insert into public.work_order_triage (company_id, work_order_id, source, model, suggestion)
  values (v_wo.company_id, p_wo, p_source, left(coalesce(p_model, ''), 80), p_suggestion)
  returning id into v_id;
  perform private.wo_event(v_wo.company_id, p_wo, 'triage', null, null,
    case when p_source = 'ai' then 'AI triage suggested (not yet reviewed)' else 'Triage suggested by rules (not yet reviewed)' end,
    jsonb_build_object('triage_id', v_id, 'source', p_source));
  return v_id;
end;
$$;

-- A person's decision. accepted applies the suggestion; edited applies the person's category and urgency; rejected
-- applies nothing. A safety review can only ever add the safety-critical flag, never remove it.
create or replace function public.maintenance_decide_triage(p_triage uuid, p_decision text, p_category text default null,
  p_urgency text default null, p_safety boolean default null, p_note text default '')
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_t public.work_order_triage%rowtype;
  v_wo public.work_orders%rowtype;
  v_category text;
  v_urgency text;
  v_safety boolean;
  v_note text := private.clean_text(p_note, 1000, 'Note');
begin
  select * into v_t from public.work_order_triage where id = p_triage and company_id = private.require_company() for update;
  if not found then
    raise exception 'Suggestion not found.' using errcode = 'P0002';
  end if;
  v_wo := private.wo_for_crew(v_t.work_order_id);
  if v_t.status <> 'suggested' then
    raise exception 'This suggestion was already %.', v_t.status using errcode = 'P0001';
  end if;
  if coalesce(p_decision, '') not in ('accepted', 'edited', 'rejected') then
    raise exception 'Choose accept, edit or reject.' using errcode = '22023';
  end if;
  if p_decision = 'rejected' and length(v_note) < 3 then
    raise exception 'Say why the suggestion is rejected.' using errcode = '22023';
  end if;

  if p_decision <> 'rejected' then
    v_category := case when p_decision = 'accepted' then v_t.suggestion ->> 'category' else p_category end;
    v_urgency := case when p_decision = 'accepted' then v_t.suggestion ->> 'urgency' else p_urgency end;
    v_safety := case when p_decision = 'accepted' then (v_t.suggestion ->> 'safetyReview')::boolean else coalesce(p_safety, false) end;
    if coalesce(v_category, '') not in ('preventive', 'repair', 'inspection', 'brakes', 'tires', 'engine', 'electrical', 'hydraulics', 'body', 'other')
       or coalesce(v_urgency, '') not in ('low', 'normal', 'high', 'immediate') then
      raise exception 'Choose a category and an urgency.' using errcode = '22023';
    end if;
    -- The existing update path applies the change, so its rules (restricting the vehicle when safety-critical) run as
    -- for any edit. Safety is only ever added here.
    perform public.maintenance_update_work_order(v_wo.id, v_wo.edit_seq, jsonb_build_object(
      'category', v_category, 'urgency', v_urgency, 'safety_critical', v_wo.safety_critical or v_safety));
  end if;

  update public.work_order_triage set status = p_decision, decided_by = auth.uid(), decided_at = now(), decision_note = v_note,
    decision = jsonb_build_object('category', v_category, 'urgency', v_urgency, 'safety_critical', v_safety)
  where id = p_triage;
  perform private.wo_event(v_wo.company_id, v_wo.id, 'triage', null, null,
    format('Triage %s%s', p_decision, case when length(v_note) > 0 then ': ' || v_note else '' end),
    jsonb_build_object('triage_id', p_triage, 'source', v_t.source, 'decision', p_decision));
end;
$$;

revoke all on function public.maintenance_save_triage(uuid, text, text, jsonb),
  public.maintenance_decide_triage(uuid, text, text, text, boolean, text) from public, anon;
grant execute on function public.maintenance_save_triage(uuid, text, text, jsonb),
  public.maintenance_decide_triage(uuid, text, text, text, boolean, text) to authenticated;
