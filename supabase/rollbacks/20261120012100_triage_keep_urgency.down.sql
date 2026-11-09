-- Rollback of 20261120012100_triage_keep_urgency: restores public.maintenance_decide_triage as it was before
-- (20261120003100). Function only.

CREATE OR REPLACE FUNCTION public.maintenance_decide_triage(p_triage uuid, p_decision text, p_category text DEFAULT NULL::text, p_urgency text DEFAULT NULL::text, p_safety boolean DEFAULT NULL::boolean, p_note text DEFAULT ''::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
$function$

;
