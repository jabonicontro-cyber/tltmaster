-- Rollback of 20261111000200_demo_people_names.sql (not a migration; run by hand with a backup first).
-- Restores the Command Center name lookups to account profile names.
begin;
CREATE OR REPLACE FUNCTION public.command_center_exceptions(p_kind text DEFAULT NULL::text, p_mine boolean DEFAULT false, p_limit integer DEFAULT 25, p_offset integer DEFAULT 0, p_hidden boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_company uuid := private.require_command_center();
  v_limit   integer := least(greatest(coalesce(p_limit, 25), 1), 100);
  v_offset  integer := greatest(coalesce(p_offset, 0), 0);
  v_result  jsonb;
begin
  if p_kind is not null and private.exception_resolve_permission(p_kind) is null then
    raise exception 'Unknown exception type.';
  end if;

  with visible as (
    select e.*, x.assigned_to, x.assigned_at, x.note as assignment_note, p.full_name as assignee_name,
           case when e.priority > 1 and d.hidden_until > now() then d.hidden_until end as hidden_until
    from private.operational_exceptions(v_company) e
    left join public.exception_assignments x
      on x.company_id = v_company and x.exception_key = e.exception_key and x.ended_at is null
    left join public.profiles p on p.id = x.assigned_to
    left join public.exception_dismissals d
      on d.company_id = v_company and d.user_id = auth.uid() and d.exception_key = e.exception_key
    where private.exception_visible(e.kind)
      and (p_kind is null or e.kind = p_kind)
      and (not coalesce(p_mine, false) or x.assigned_to = auth.uid())
  ), shown as (
    select * from visible where (hidden_until is not null) = coalesce(p_hidden, false)
  ), page as (
    select * from shown
    order by priority, since nulls last, exception_key
    limit v_limit offset v_offset
  )
  select jsonb_build_object(
    'total', (select count(*) from shown),
    'hidden', (select count(*) from visible where hidden_until is not null),
    'limit', v_limit,
    'offset', v_offset,
    'items', coalesce((select jsonb_agg(to_jsonb(page) order by priority, since nulls last, exception_key) from page), '[]'))
  into v_result;
  return v_result;
end;
$function$;

CREATE OR REPLACE FUNCTION public.exception_assignee_options()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_company uuid;
begin
  perform private.require_permission('exceptions.assign');
  v_company := private.require_company();
  return coalesce((
    select jsonb_agg(jsonb_build_object('user_id', m.user_id, 'name', coalesce(nullif(trim(p.full_name), ''), 'Unnamed user'),
                                        'role', m.role, 'kinds', k.kinds) order by p.full_name)
    from public.company_memberships m
    join public.profiles p on p.id = m.user_id
    cross join lateral (
      select coalesce(jsonb_agg(kind order by kind), '[]') as kinds
      from unnest(array['missing_ticket', 'unassigned_load', 'ticket_review', 'billing_blocked',
                        'equipment_out_of_service', 'assignment_problem',
                        'delay_report', 'equipment_report', 'urgent_order', 'order_unscheduled']) kind
      where exists (select 1 from public.role_permissions rp
                    where rp.company_id = v_company and rp.role = m.role
                      and rp.permission = private.exception_resolve_permission(kind))
        and (kind <> 'delay_report' or exists (select 1 from public.role_permissions rp
                    where rp.company_id = v_company and rp.role = m.role and rp.permission = 'dispatch.view'))
    ) k
    where m.company_id = v_company and m.active and m.role is not null and jsonb_array_length(k.kinds) > 0), '[]');
end;
$function$;

CREATE OR REPLACE FUNCTION public.assign_exception(p_key text, p_user_id uuid, p_note text DEFAULT ''::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_company uuid;
  v_e       record;
  v_note    text := private.clean_text(p_note, 300, 'Note');
  v_role    public.app_role;
  v_name    text;
  v_current public.exception_assignments%rowtype;
  v_id      uuid;
begin
  perform private.require_permission('exceptions.assign');
  v_company := private.require_company();

  select * into v_e from private.operational_exceptions(v_company) e
  where e.exception_key = p_key and private.exception_visible(e.kind);
  if not found then
    raise exception 'This item is no longer open. Refresh the command center.' using errcode = 'PT409';
  end if;

  select m.role, coalesce(nullif(trim(p.full_name), ''), 'Unnamed user') into v_role, v_name
  from public.company_memberships m join public.profiles p on p.id = m.user_id
  where m.company_id = v_company and m.user_id = p_user_id and m.active and m.role is not null;
  if not found then raise exception 'Choose an active member of this company.'; end if;
  if not exists (select 1 from public.role_permissions
                 where company_id = v_company and role = v_role
                   and permission = private.exception_resolve_permission(v_e.kind)) then
    raise exception '% cannot resolve this item (needs %).', v_name, private.exception_resolve_permission(v_e.kind);
  end if;
  if v_e.kind = 'delay_report' and not exists (select 1 from public.role_permissions
                 where company_id = v_company and role = v_role and permission = 'dispatch.view') then
    raise exception '% cannot resolve this item (needs dispatch.view).', v_name;
  end if;

  select * into v_current from public.exception_assignments
  where company_id = v_company and exception_key = p_key and ended_at is null for update;
  if found then
    if v_current.assigned_to = p_user_id then
      raise exception 'This item is already assigned to %.', v_name using errcode = 'PT409';
    end if;
    update public.exception_assignments set ended_at = now(), ended_by = auth.uid(), end_reason = 'reassigned'
    where id = v_current.id;
  end if;

  begin
    insert into public.exception_assignments (company_id, exception_key, kind, assigned_to, note, assigned_by)
    values (v_company, p_key, v_e.kind, p_user_id, v_note, auth.uid())
    returning id into v_id;
  exception when unique_violation then
    raise exception 'Someone else just assigned this item. Refresh and try again.' using errcode = 'PT409';
  end;

  perform private.log_event('exception.assigned',
    case when v_e.order_id is not null then 'order' else coalesce(v_e.equipment_kind, 'company') end,
    coalesce(v_e.order_id, v_e.equipment_id),
    format('%s assigned to %s%s', replace(v_e.kind, '_', ' '), v_name, case when v_note <> '' then ': ' || v_note else '' end),
    jsonb_build_object('exception_key', p_key, 'assigned_to', p_user_id, 'assignment_id', v_id));
  return jsonb_build_object('assignment_id', v_id, 'assignee', v_name);
end;
$function$;
commit;
