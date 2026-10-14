-- Rollback of 20261112000400_time_off_approval_chain.sql (not a migration; run by hand with a backup first).
-- Restores time_off_decide from 20261112000100 and removes the chain. Pending requests then need one approval.
-- Refuses while approval-step history exists, so no history is removed.
begin;
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


drop function if exists public.time_off_set_chain(jsonb);
do $$
begin
  if exists (select 1 from public.time_off_events where kind = 'step_approved') then
    raise exception 'Approval-step history exists; export it and decide how to keep it before rolling back.';
  end if;
end $$;
alter table public.time_off_events drop constraint time_off_events_kind_check;
alter table public.time_off_events add constraint time_off_events_kind_check check (kind in ('submitted', 'updated', 'approved', 'denied', 'canceled'));
alter table public.time_off_requests drop column if exists approval_step;
drop table if exists public.time_off_approval_steps;
commit;
