-- =============================================================================
-- Time-off approval chains (owner 2026-10-13: configurable approval chains).
--
-- * public.time_off_approval_steps — a company's ordered approval steps (1–5),
--   each decided by a role (owner, office, dispatcher, mechanic, driver) with a
--   label ("Office review", "Owner"). No steps = one approval by anyone with
--   time_off.approve, exactly as before.
-- * time_off_requests.approval_step — the step a pending request waits for.
--   Each step needs time_off.approve AND the step's role; nobody decides their
--   own request; only the last step approves (balance check and usage posting
--   happen there); a denial at any step ends the request. Each passed step is a
--   'step_approved' event in the history.
--
-- Replaces public.time_off_decide (body from 20261112000100 plus the chain).
-- Depends on 20261112000100.
-- Rollback: supabase/rollbacks/20261112000400_time_off_approval_chain.down.sql
-- =============================================================================

create table public.time_off_approval_steps (
  company_id  uuid not null references public.companies (id),
  step_no     integer not null check (step_no between 1 and 5),
  role        public.app_role not null,
  label       text not null check (length(trim(label)) between 1 and 60),
  updated_by  uuid references auth.users (id) on delete set null,
  updated_at  timestamptz not null default now(),
  primary key (company_id, step_no)
);
create trigger a_company_guard before update of company_id on public.time_off_approval_steps
  for each row execute function private.forbid_company_change();
create trigger time_off_approval_steps_audit after insert or update or delete on public.time_off_approval_steps
  for each row execute function private.audit_row_change('time_off_approval_step');
alter table public.time_off_approval_steps enable row level security;
create policy time_off_approval_steps_read on public.time_off_approval_steps for select to authenticated
  using (company_id = (select private.current_company_id()));
revoke all on public.time_off_approval_steps from anon, authenticated;
grant select on public.time_off_approval_steps to authenticated;
grant all on public.time_off_approval_steps to service_role;

alter table public.time_off_requests add column approval_step integer check (approval_step is null or approval_step between 1 and 5);
alter table public.time_off_events drop constraint time_off_events_kind_check;
alter table public.time_off_events add constraint time_off_events_kind_check
  check (kind in ('submitted', 'updated', 'approved', 'denied', 'canceled', 'step_approved'));

/**
 * Replace the company's approval chain (settings.manage). p: [{ role, label }] in order; [] = single approval.
 * Requests already pending restart at step 1 so no request skips a new step.
 */
create or replace function public.time_off_set_chain(p jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v_n       integer := jsonb_array_length(coalesce(p, '[]'::jsonb));
begin
  perform private.require_permission('settings.manage');
  if v_n > 5 then raise exception 'An approval chain has at most five steps.' using errcode = 'P0001'; end if;
  perform 1 from public.companies where id = v_company for update;
  delete from public.time_off_approval_steps where company_id = v_company;
  insert into public.time_off_approval_steps (company_id, step_no, role, label, updated_by)
  select v_company, e.ord::integer, (e.value ->> 'role')::public.app_role, trim(coalesce(e.value ->> 'label', '')), auth.uid()
  from jsonb_array_elements(coalesce(p, '[]'::jsonb)) with ordinality e(value, ord);
  update public.time_off_requests set approval_step = case when v_n > 0 then 1 end, edit_seq = edit_seq + 1, updated_at = now()
  where company_id = v_company and status = 'pending';
exception
  when check_violation or invalid_text_representation then
    raise exception 'Each step needs a role and a short label (up to 60 characters).' using errcode = 'P0001';
end;
$$;

revoke all on function public.time_off_set_chain(jsonb) from public, anon;
grant execute on function public.time_off_set_chain(jsonb) to authenticated;

/** Approve or deny a pending request (time_off.approve; never one's own). Returns conflicting assignments for review. */
create or replace function public.time_off_decide(p_id uuid, p_decision text, p_note text default '')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company   uuid := private.require_company();
  v_req       public.time_off_requests%rowtype;
  v_owner     uuid;
  v_conflicts jsonb := '[]'::jsonb;
  v_balance   numeric;
  v_bank_name text;
  v_steps     integer;
  v_step      public.time_off_approval_steps%rowtype;
  v_role      public.app_role;
begin
  perform private.require_permission('time_off.approve');
  if p_decision not in ('approved', 'denied') then raise exception 'Choose approve or deny.'; end if;
  select * into v_req from public.time_off_requests where id = p_id and company_id = v_company for update;
  if not found then raise exception 'Request not found.' using errcode = 'P0002'; end if;
  select user_id into v_owner from public.employees where id = v_req.employee_id;
  if v_owner = auth.uid() then
    raise exception 'You cannot decide your own time-off request. Another approver must decide it.' using errcode = '42501';
  end if;
  if v_req.status <> 'pending' then
    raise exception 'This request is already %.', v_req.status using errcode = 'P0001';
  end if;
  -- Approval chain (20261112000400): with steps configured, each step is decided by someone whose role matches it;
  -- only the last step approves the request. A denial at any step ends it.
  select count(*) into v_steps from public.time_off_approval_steps where company_id = v_company;
  if v_steps > 0 then
    select * into v_step from public.time_off_approval_steps where company_id = v_company and step_no = coalesce(v_req.approval_step, 1);
    select m.role into v_role from public.company_memberships m where m.company_id = v_company and m.user_id = auth.uid() and m.active;
    if v_role is distinct from v_step.role then
      raise exception 'This request waits for step % (%): someone with the % role decides it.', v_step.step_no, v_step.label, v_step.role using errcode = '42501';
    end if;
    if p_decision = 'approved' and v_step.step_no < v_steps then
      update public.time_off_requests set approval_step = v_step.step_no + 1, edit_seq = edit_seq + 1, updated_at = now() where id = p_id;
      perform private.time_off_event(v_company, p_id, 'step_approved', p_note, jsonb_build_object('step', v_step.step_no, 'label', v_step.label));
      return jsonb_build_object('status', 'pending', 'step', v_step.step_no + 1, 'conflicts', '[]'::jsonb);
    end if;
  end if;
  -- A request on a PTO bank uses its hours when approved: checked against the balance at this moment (the employee row
  -- is locked so concurrent approvals and adjustments cannot both spend the same hours), then posted to the ledger.
  if p_decision = 'approved' and v_req.pto_bank_id is not null then
    perform 1 from public.employees where id = v_req.employee_id and company_id = v_company for update;
    v_balance := private.pto_balance(v_company, v_req.employee_id, v_req.pto_bank_id);
    select name into v_bank_name from public.pto_banks where id = v_req.pto_bank_id;
    if v_req.hours is null or v_req.hours > v_balance then
      raise exception 'Approving uses % h of %, but the balance is % h. Adjust the balance or ask for a shorter request.',
        trim_scale(coalesce(v_req.hours, 0)), v_bank_name, trim_scale(v_balance) using errcode = 'P0001';
    end if;
    insert into public.pto_ledger (company_id, bank_id, employee_id, kind, hours, effective_on, request_id, note, created_by)
    values (v_company, v_req.pto_bank_id, v_req.employee_id, 'usage', -v_req.hours, v_req.start_date, p_id, '', auth.uid());
  end if;
  update public.time_off_requests set status = p_decision, decided_by = auth.uid(), decided_at = now(),
    decision_note = private.clean_text(p_note, 1000, 'Note'), edit_seq = edit_seq + 1, updated_at = now()
  where id = p_id;
  if p_decision = 'approved' then
    v_conflicts := private.time_off_assignment_conflicts(v_company, p_id);
  end if;
  perform private.time_off_event(v_company, p_id, p_decision, p_note, jsonb_build_object('conflicting_assignments', v_conflicts));
  return jsonb_build_object('status', p_decision, 'conflicts', v_conflicts);
end;
$$;

