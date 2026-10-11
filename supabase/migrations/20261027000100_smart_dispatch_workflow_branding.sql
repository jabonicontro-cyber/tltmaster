-- =============================================================================
-- N15: Smart Dispatch support, workflow reliability, company branding.
--
-- Additive. Existing functions are redefined from their current definitions
-- with only the additions described here; nothing is deleted.
--
-- 1. Safety: a truck or trailer with an unresolved driver report of a
--    breakdown or an inspection problem is not eligible for assignment (hard
--    block) until the report is resolved; an unresolved "equipment issue"
--    report is a warning. (Implementation choice pending business confirmation
--    of which defects stop dispatch — see TAVIRON_MASTER_PLAN §4.)
-- 2. Capacity: assigning a load whose planned quantity (tons or cubic yards)
--    exceeds the recorded capacity of the truck (plus trailer) is refused.
--    Unknown capacity is not treated as enough or too little (warning only).
-- 3. Smart Dispatch rejections: a dispatcher can reject a recommended
--    truck/driver pair for a load (recorded, audited); recommendations
--    themselves are computed on demand and never stored or committed.
--    Approval always goes through public.assign_load.
-- 4. Accepting a quote creates its order automatically (once), as Confirmed,
--    in the same transaction. public.convert_quote_to_order stays and returns
--    the same order.
-- 5. Scheduling an order requires a delivery location (a job-site address or
--    a site name, e.g. "Customer pickup at the yard").
-- 6. Fulfillment is derived (public.order_fulfillment): every planned load has
--    happened and has an accepted ticket, nothing waits for review, and every
--    ticketed line has at least its ordered quantity accepted. A fulfilled
--    order can become billing-ready without first being marked Completed; a
--    partially fulfilled one cannot. Quantity checks apply to fulfilled orders
--    as they do to completed ones.
-- 7. Company branding: logo and colors in company_settings (per company, RLS).
-- =============================================================================


CREATE OR REPLACE FUNCTION private.eligibility_message(p_code text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  select case p_code
    when 'truck_inactive' then 'Truck is deactivated.'
    when 'truck_out_of_service' then 'Truck is out of service.'
    when 'truck_capacity_unknown' then 'Truck capacity is not recorded.'
    when 'truck_capacity_unverified' then 'Truck capacity is recorded but not verified.'
    when 'trailer_inactive' then 'Trailer is deactivated.'
    when 'trailer_out_of_service' then 'Trailer is out of service.'
    when 'trailer_capacity_unknown' then 'Trailer capacity is not recorded.'
    when 'trailer_capacity_unverified' then 'Trailer capacity is recorded but not verified.'
    when 'trailer_incompatible' then 'This trailer is not recorded as compatible with this truck type.'
    when 'trailer_compatibility_unknown' then 'Trailer compatibility is not recorded.'
    when 'trailer_required' then 'A tractor needs a trailer for this load.'
    when 'driver_inactive' then 'Driver is inactive.'
    when 'cdl_missing' then 'No CDL is recorded for this driver.'
    when 'cdl_class_insufficient' then 'Driver''s CDL class is not high enough for this combination.'
    when 'cdl_expired' then 'Driver''s CDL has expired.'
    when 'cdl_expiry_unknown' then 'Driver''s CDL expiry date is not recorded.'
    when 'cdl_unverified' then 'Driver''s CDL has not been verified.'
    when 'cdl_expiring_soon' then 'Driver''s CDL expires within 30 days.'
    when 'medical_card_missing' then 'No DOT medical card is recorded for this driver.'
    when 'medical_card_class_insufficient' then 'Medical card does not qualify.'
    when 'medical_card_expired' then 'Driver''s medical card has expired.'
    when 'medical_card_expiry_unknown' then 'Driver''s medical card expiry date is not recorded.'
    when 'medical_card_unverified' then 'Driver''s medical card has not been verified.'
    when 'medical_card_expiring_soon' then 'Driver''s medical card expires within 30 days.'
    when 'truck_safety_report_open' then 'A driver reported a breakdown or inspection problem on this truck that is not resolved yet.'
    when 'trailer_safety_report_open' then 'A driver reported a breakdown or inspection problem on this trailer that is not resolved yet.'
    when 'truck_equipment_report_open' then 'A driver reported an equipment issue on this truck that is not resolved yet.'
    when 'trailer_equipment_report_open' then 'A driver reported an equipment issue on this trailer that is not resolved yet.'
    else p_code
  end
$function$;

CREATE OR REPLACE FUNCTION private.assignment_eligibility(p_company uuid, p_truck_id uuid, p_trailer_id uuid, p_driver_id uuid, p_on date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_company  uuid;
  v_on       date;
  v_truck    public.trucks%rowtype;
  v_trailer  public.trailers%rowtype;
  v_driver   public.drivers%rowtype;
  v_blockers text[] := '{}';
  v_warnings text[] := '{}';
  v_state    text;
  v_min      public.cdl_class;
  v_soon     date;
begin
  v_company := p_company;
  v_on := coalesce(p_on, private.business_today(v_company));
  v_soon := v_on + 30;

  if p_truck_id is null and p_trailer_id is null and p_driver_id is null then
    raise exception 'Choose a truck, a trailer or a driver.';
  end if;

  if p_truck_id is not null then
    select * into v_truck from public.trucks where id = p_truck_id and company_id = v_company;
    if not found then raise exception 'Truck not found.'; end if;
    if not v_truck.active then v_blockers := v_blockers || 'truck_inactive'::text; end if;
    if v_truck.service_status = 'out_of_service' then v_blockers := v_blockers || 'truck_out_of_service'::text; end if;
    if v_truck.weight_capacity is null and v_truck.volume_capacity is null then
      v_warnings := v_warnings || 'truck_capacity_unknown'::text;
    elsif v_truck.capacity_verified_at is null then
      v_warnings := v_warnings || 'truck_capacity_unverified'::text;
    end if;
  end if;

  if p_trailer_id is not null then
    select * into v_trailer from public.trailers where id = p_trailer_id and company_id = v_company;
    if not found then raise exception 'Trailer not found.'; end if;
    if not v_trailer.active then v_blockers := v_blockers || 'trailer_inactive'::text; end if;
    if v_trailer.service_status = 'out_of_service' then v_blockers := v_blockers || 'trailer_out_of_service'::text; end if;
    if v_trailer.weight_capacity is null and v_trailer.volume_capacity is null then
      v_warnings := v_warnings || 'trailer_capacity_unknown'::text;
    elsif v_trailer.capacity_verified_at is null then
      v_warnings := v_warnings || 'trailer_capacity_unverified'::text;
    end if;
    if p_truck_id is not null then
      if cardinality(v_trailer.compatible_truck_types) = 0 then
        v_warnings := v_warnings || 'trailer_compatibility_unknown'::text;
      elsif not (v_truck.truck_type = any (v_trailer.compatible_truck_types)) then
        v_blockers := v_blockers || 'trailer_incompatible'::text;
      end if;
    end if;
  end if;

  -- Unresolved driver reports about the equipment (N15).
  if p_truck_id is not null then
    if exists (select 1 from public.field_reports r where r.company_id = v_company and r.equipment = 'truck' and r.truck_id = p_truck_id
               and r.status in ('open', 'acknowledged') and r.kind in ('breakdown', 'inspection_issue')) then
      v_blockers := v_blockers || 'truck_safety_report_open'::text;
    elsif exists (select 1 from public.field_reports r where r.company_id = v_company and r.equipment = 'truck' and r.truck_id = p_truck_id
                  and r.status in ('open', 'acknowledged') and r.kind = 'equipment_issue') then
      v_warnings := v_warnings || 'truck_equipment_report_open'::text;
    end if;
  end if;
  if p_trailer_id is not null then
    if exists (select 1 from public.field_reports r where r.company_id = v_company and r.equipment = 'trailer' and r.trailer_id = p_trailer_id
               and r.status in ('open', 'acknowledged') and r.kind in ('breakdown', 'inspection_issue')) then
      v_blockers := v_blockers || 'trailer_safety_report_open'::text;
    elsif exists (select 1 from public.field_reports r where r.company_id = v_company and r.equipment = 'trailer' and r.trailer_id = p_trailer_id
                  and r.status in ('open', 'acknowledged') and r.kind = 'equipment_issue') then
      v_warnings := v_warnings || 'trailer_equipment_report_open'::text;
    end if;
  end if;

  if p_driver_id is not null then
    select * into v_driver from public.drivers where id = p_driver_id and company_id = v_company;
    if not found then raise exception 'Driver not found.'; end if;
    if not v_driver.active then v_blockers := v_blockers || 'driver_inactive'::text; end if;

    v_min := case when p_trailer_id is not null then 'A'::public.cdl_class else 'B'::public.cdl_class end;
    v_state := private.qualification_check(p_driver_id, 'cdl', v_min, v_on);
    if v_state <> 'ok' then
      v_blockers := v_blockers || ('cdl_' || v_state);
    elsif not exists (select 1 from public.driver_qualifications
                      where driver_id = p_driver_id and kind = 'cdl' and verified_at is not null
                        and private.cdl_class_rank(cdl_class) >= private.cdl_class_rank(v_min)
                        and expires_on > v_soon) then
      v_warnings := v_warnings || 'cdl_expiring_soon'::text;
    end if;

    v_state := private.qualification_check(p_driver_id, 'medical_card', null, v_on);
    if v_state <> 'ok' then
      v_blockers := v_blockers || ('medical_card_' || v_state);
    elsif not exists (select 1 from public.driver_qualifications
                      where driver_id = p_driver_id and kind = 'medical_card' and verified_at is not null
                        and expires_on > v_soon) then
      v_warnings := v_warnings || 'medical_card_expiring_soon'::text;
    end if;
  end if;

  return jsonb_build_object(
    'on', v_on,
    'eligible', cardinality(v_blockers) = 0,
    'blockers', to_jsonb(v_blockers),
    'warnings', to_jsonb(v_warnings));
end;
$function$;

create or replace function private.load_capacity_problem(p_company uuid, p_truck_id uuid, p_trailer_id uuid, p_quantity numeric, p_unit text)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_cap   numeric := 0;
  v_known boolean := false;
  r       record;
begin
  if p_quantity is null or p_unit is null or p_unit not in ('ton', 'cu_yd') then
    return null;
  end if;
  for r in
    select weight_capacity, weight_unit::text as weight_unit, volume_capacity from public.trucks where id = p_truck_id and company_id = p_company
    union all
    select weight_capacity, weight_unit::text, volume_capacity from public.trailers where id = p_trailer_id and company_id = p_company
  loop
    if p_unit = 'ton' and r.weight_capacity is not null then
      v_cap := v_cap + case when r.weight_unit = 'lb' then r.weight_capacity / 2000 else r.weight_capacity end;
      v_known := true;
    elsif p_unit = 'cu_yd' and r.volume_capacity is not null then
      v_cap := v_cap + r.volume_capacity;
      v_known := true;
    end if;
  end loop;
  if v_known and p_quantity > v_cap then
    return format('The load is planned at %s %s, more than the recorded capacity of %s %s. Split the load or choose larger equipment.',
                  trim(to_char(p_quantity, 'FM999999990.###')), replace(p_unit, '_', ' '),
                  trim(to_char(v_cap, 'FM999999990.###')), replace(p_unit, '_', ' '));
  end if;
  return null;
end;
$$;

CREATE OR REPLACE FUNCTION public.assign_load(p_load_id uuid, p_truck_id uuid, p_trailer_id uuid, p_driver_id uuid, p_note text DEFAULT ''::text, p_replace_assignment_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_company    uuid;
  v_load       public.order_loads%rowtype;
  v_order      public.orders%rowtype;
  v_current    public.dispatch_assignments%rowtype;
  v_has_current boolean;
  v_warnings   text[];
  v_new        public.dispatch_assignments%rowtype;
  v_constraint text;
  v_note       text := private.clean_text(p_note, 500, 'Note');
  v_capacity   text;
begin
  perform private.require_permission('dispatch.edit');
  v_company := private.require_company();

  select * into v_load from public.order_loads where id = p_load_id and company_id = v_company for update;
  if not found then raise exception 'Load not found.'; end if;
  select * into v_order from public.orders where id = v_load.order_id;
  if v_load.status = 'canceled' then
    raise exception '% load % is canceled.', v_order.order_number, v_load.load_number;
  end if;
  if not private.order_is_dispatchable(v_order.status) then
    raise exception 'Order % is %. Mark it scheduled before assigning trucks.',
      v_order.order_number, replace(v_order.status::text, '_', ' ');
  end if;

  -- Capacity (N15): never assign more than the equipment's recorded capacity.
  v_capacity := private.load_capacity_problem(v_company, p_truck_id, p_trailer_id, v_load.planned_quantity, v_load.unit_code);
  if v_capacity is not null then
    raise exception 'Not eligible: %', v_capacity;
  end if;

  select * into v_current from public.dispatch_assignments where load_id = v_load.id and status = 'active' for update;
  v_has_current := found;
  if v_has_current is distinct from (p_replace_assignment_id is not null)
     or (v_has_current and v_current.id <> p_replace_assignment_id) then
    raise exception 'The assignment of % load % was changed by someone else. Reload the board.',
      v_order.order_number, v_load.load_number using errcode = 'PT409';
  end if;
  if v_has_current and (v_current.truck_id, v_current.trailer_id, v_current.driver_id)
                       is not distinct from (p_truck_id, p_trailer_id, p_driver_id) then
    raise exception 'This load is already assigned to that truck, trailer and driver.';
  end if;

  v_warnings := private.check_assignment(v_company, p_truck_id, p_trailer_id, p_driver_id,
                                          v_load.load_date, v_load.starts_at, v_load.ends_at,
                                          case when v_has_current then v_current.id end);

  if v_has_current then
    update public.dispatch_assignments set status = 'canceled', canceled_at = now(), canceled_by = auth.uid(),
      cancel_reason = 'Reassigned' || coalesce(': ' || nullif(v_note, ''), '')
    where id = v_current.id;
  end if;

  begin
    insert into public.dispatch_assignments (company_id, load_id, order_id, truck_id, trailer_id, driver_id,
                                             starts_at, ends_at, note, warnings, replaces_assignment_id, created_by)
    values (v_company, v_load.id, v_order.id, p_truck_id, p_trailer_id, p_driver_id,
            v_load.starts_at, v_load.ends_at, v_note, v_warnings,
            case when v_has_current then v_current.id end, auth.uid())
    returning * into v_new;
  exception when exclusion_violation then
    -- Another request booked the same resource at the same moment.
    get stacked diagnostics v_constraint = constraint_name;
    raise exception '% was just assigned to another load at this time by someone else. Reload the board.',
      case when v_constraint like '%truck%' then 'The truck'
           when v_constraint like '%trailer%' then 'The trailer'
           else 'The driver' end
      using errcode = 'PT409';
  end;

  perform private.log_event(case when v_has_current then 'dispatch.reassigned' else 'dispatch.assigned' end,
    'order', v_order.id,
    format('%s load %s %s: %s', v_order.order_number, v_load.load_number,
           case when v_has_current then 'reassigned' else 'assigned' end,
           private.assignment_label(p_truck_id, p_trailer_id, p_driver_id)),
    jsonb_build_object('load_id', v_load.id, 'assignment_id', v_new.id,
                       'replaces_assignment_id', case when v_has_current then v_current.id end,
                       'previous', case when v_has_current then private.assignment_label(v_current.truck_id, v_current.trailer_id, v_current.driver_id) end,
                       'warnings', to_jsonb(v_warnings)));

  return jsonb_build_object('assignment_id', v_new.id, 'warnings', to_jsonb(v_warnings));
end;
$function$;

CREATE OR REPLACE FUNCTION public.set_order_status(p_order_id uuid, p_status order_status, p_note text DEFAULT ''::text, p_expected_edit_seq integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_order   public.orders%rowtype;
  v_company uuid;
  v_note    text := private.clean_text(p_note, 1000, 'Note');
  v_from    public.order_status;
begin
  v_company := private.require_company();

  select * into v_order from public.orders where id = p_order_id and company_id = v_company for update;
  if not found then
    raise exception 'Order not found.';
  end if;
  v_from := v_order.status;
  if p_status is null or p_status = v_order.status then
    raise exception 'Order % is already %.', v_order.order_number, replace(v_order.status::text, '_', ' ');
  end if;
  if not private.order_transition_allowed(v_order.status, p_status) then
    raise exception 'Order % cannot move from % to %.', v_order.order_number,
      replace(v_order.status::text, '_', ' '), replace(p_status::text, '_', ' ');
  end if;
  perform private.require_permission(private.order_transition_permission(v_order.status, p_status));
  if p_expected_edit_seq is not null and p_expected_edit_seq <> v_order.edit_seq then
    raise exception 'This order was changed by someone else. Reload to see the latest version.'
      using errcode = 'PT409';
  end if;

  if p_status in ('on_hold', 'canceled') and length(v_note) = 0 then
    raise exception 'Enter a reason for putting the order %.',
      case when p_status = 'canceled' then 'as canceled' else 'on hold' end;
  end if;
  if p_status in ('scheduled', 'dispatched', 'in_progress') and v_order.scheduled_start is null then
    raise exception 'Set a scheduled date before marking the order %.', replace(p_status::text, '_', ' ');
  end if;
  if p_status = 'scheduled' and coalesce(nullif(trim(v_order.site_line1), ''), nullif(trim(v_order.site_label), '')) is null then
    raise exception 'Add the delivery location to order % before scheduling it: a job-site address, or a site name such as "Customer pickup at the yard".', v_order.order_number;
  end if;
  if p_status = 'confirmed' and not exists (select 1 from public.order_lines where order_id = v_order.id) then
    raise exception 'Add at least one line before confirming the order.';
  end if;

  update public.orders set
    status           = p_status,
    status_note      = v_note,
    bill_to_snapshot = case when v_order.status = 'draft' and v_order.source_quote_id is null
                            then private.customer_bill_to(v_order.customer_id) else bill_to_snapshot end,
    confirmed_at     = case when p_status = 'confirmed' then coalesce(confirmed_at, now()) else confirmed_at end,
    completed_at     = case when p_status = 'completed' then now() else completed_at end,
    canceled_at      = case when p_status = 'canceled' then now() else canceled_at end,
    edit_seq         = edit_seq + 1,
    updated_by       = auth.uid()
  where id = v_order.id
  returning * into v_order;

  insert into public.order_status_events (company_id, order_id, from_status, to_status, note, actor_id)
  values (v_company, v_order.id, v_from, p_status, v_note, auth.uid());

  perform private.log_event('order.status_changed', 'order', v_order.id,
    format('%s: %s → %s%s', v_order.order_number, replace(v_from::text, '_', ' '),
           replace(p_status::text, '_', ' '), case when length(v_note) > 0 then ' (' || v_note || ')' else '' end),
    jsonb_build_object('from', v_from, 'to', p_status, 'note', v_note, 'edit_seq', v_order.edit_seq));

  return jsonb_build_object('order_id', v_order.id, 'status', v_order.status, 'edit_seq', v_order.edit_seq);
end;
$function$;

create table public.dispatch_recommendation_rejections (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null default private.current_company_id() references public.companies (id),
  load_id     uuid not null,
  truck_id    uuid not null,
  driver_id   uuid not null,
  reason      text not null default '' check (length(reason) <= 300),
  rejected_by uuid default auth.uid(),
  created_at  timestamptz not null default now(),
  cleared_at  timestamptz,
  cleared_by  uuid,
  foreign key (company_id, load_id) references public.order_loads (company_id, id) on delete cascade,
  foreign key (company_id, truck_id) references public.trucks (company_id, id),
  foreign key (company_id, driver_id) references public.drivers (company_id, id)
);
create unique index dispatch_rejections_active on public.dispatch_recommendation_rejections (load_id, truck_id, driver_id) where cleared_at is null;
alter table public.dispatch_recommendation_rejections enable row level security;
create policy dispatch_rejections_read on public.dispatch_recommendation_rejections for select to authenticated
  using (company_id = (select private.current_company_id()) and private.has_permission('dispatch.view'));
revoke insert, update, delete on public.dispatch_recommendation_rejections from anon, authenticated;
grant select on public.dispatch_recommendation_rejections to authenticated;
create trigger a_company_guard before update of company_id on public.dispatch_recommendation_rejections
  for each row execute function private.forbid_company_change();

-- A dispatcher rejects one recommended truck/driver pair for a load. Repeats
-- are no-ops. Nothing is assigned or unassigned.
create or replace function public.reject_dispatch_recommendation(p_load_id uuid, p_truck_id uuid, p_driver_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid;
  v_load    public.order_loads%rowtype;
begin
  perform private.require_permission('dispatch.edit');
  v_company := private.require_company();
  select * into v_load from public.order_loads where id = p_load_id and company_id = v_company;
  if not found then raise exception 'Load not found.'; end if;
  if not exists (select 1 from public.trucks where id = p_truck_id and company_id = v_company)
     or not exists (select 1 from public.drivers where id = p_driver_id and company_id = v_company) then
    raise exception 'Truck or driver not found.';
  end if;
  insert into public.dispatch_recommendation_rejections (company_id, load_id, truck_id, driver_id, reason)
  values (v_company, p_load_id, p_truck_id, p_driver_id, private.clean_text(p_reason, 300, 'Reason'))
  on conflict do nothing;
  perform private.log_event('dispatch.recommendation_rejected', 'order', v_load.order_id,
    format('Recommendation rejected for load %s: %s', v_load.load_number, private.assignment_label(p_truck_id, null, p_driver_id)),
    jsonb_build_object('load_id', p_load_id, 'truck_id', p_truck_id, 'driver_id', p_driver_id, 'reason', coalesce(p_reason, '')));
end;
$$;

-- Clear a load's rejections so every pair is considered again.
create or replace function public.reconsider_dispatch_recommendations(p_load_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid;
  v_load    public.order_loads%rowtype;
  v_n       integer;
begin
  perform private.require_permission('dispatch.edit');
  v_company := private.require_company();
  select * into v_load from public.order_loads where id = p_load_id and company_id = v_company;
  if not found then raise exception 'Load not found.'; end if;
  update public.dispatch_recommendation_rejections set cleared_at = now(), cleared_by = auth.uid()
  where load_id = p_load_id and company_id = v_company and cleared_at is null;
  get diagnostics v_n = row_count;
  if v_n > 0 then
    perform private.log_event('dispatch.recommendations_reconsidered', 'order', v_load.order_id,
      format('Rejected recommendations cleared for load %s', v_load.load_number), jsonb_build_object('load_id', p_load_id, 'cleared', v_n));
  end if;
  return v_n;
end;
$$;

CREATE OR REPLACE FUNCTION private.create_order_from_quote(p_quote_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_quote    public.quotes%rowtype;
  v_version  public.quote_versions%rowtype;
  v_existing public.orders%rowtype;
  v_order    public.orders%rowtype;
  v_lines    integer;
  v_company  uuid;
begin
  -- Called by the quote-acceptance trigger, in the accepting user's
  -- transaction; the quote's own company is the target.
  select company_id into v_company from public.quotes where id = p_quote_id;

  -- Serializes concurrent conversions of the same quote.
  select * into v_quote from public.quotes where id = p_quote_id and company_id = v_company for update;
  if not found then
    raise exception 'Quote not found.';
  end if;

  select * into v_existing from public.orders where source_quote_id = p_quote_id and company_id = v_company;
  if found then
    return jsonb_build_object('order_id', v_existing.id, 'order_number', v_existing.order_number, 'created', false);
  end if;

  if v_quote.status <> 'accepted' then
    raise exception 'Quote % is %. Only accepted quotes can be converted to an order.',
      v_quote.quote_number, v_quote.status;
  end if;

  select * into v_version from public.quote_versions where id = v_quote.accepted_version_id;
  if not found or v_version.locked_at is null then
    raise exception 'Quote % has no issued accepted revision to convert.', v_quote.quote_number;
  end if;

  select count(*) into v_lines from public.quote_lines where quote_version_id = v_version.id;
  if v_lines = 0 then
    raise exception 'Quote % has no lines to convert.', v_quote.quote_number;
  end if;

  insert into public.orders (
    company_id, order_number, customer_id, status, source_quote_id, source_quote_version_id,
    order_date, confirmed_at, contact_id,
    bill_to_snapshot, contact_name, contact_email, contact_phone,
    site_id, site_label, site_line1, site_line2, site_city, site_state, site_postal_code,
    project_name, customer_po, job_instructions, terms, internal_notes,
    tax_rate_bp, subtotal_cents, discount_cents, taxable_cents, tax_cents, total_cents,
    is_sample, created_by, updated_by)
  values (
    v_company, private.next_document_number(v_company, 'order'), v_quote.customer_id, 'confirmed', v_quote.id, v_version.id,
    private.business_today(v_company), now(), v_version.contact_id,
    v_version.bill_to_snapshot, v_version.contact_name, v_version.contact_email, v_version.contact_phone,
    v_version.site_id, v_version.site_label, v_version.site_line1, v_version.site_line2,
    v_version.site_city, v_version.site_state, v_version.site_postal_code,
    v_version.project_name, v_version.customer_po, v_version.job_instructions, v_version.terms,
    v_version.internal_notes,
    v_version.tax_rate_bp, v_version.subtotal_cents, v_version.discount_cents, v_version.taxable_cents,
    v_version.tax_cents, v_version.total_cents,
    v_quote.is_sample, auth.uid(), auth.uid())
  returning * into v_order;

  perform set_config('tlt.order_conversion', 'on', true);

  insert into public.order_lines (
    company_id, order_id, line_no, source_quote_line_id, kind, calc_method, material_id, charge_item_id,
    description, unit_code, unit_label, quantity, unit_rate_cents, percent_bp,
    catalog_rate_cents, catalog_percent_bp, price_source, taxable, amount_cents)
  select
    v_company, v_order.id, l.line_no, l.id, l.kind, l.calc_method, l.material_id, l.charge_item_id,
    l.description, l.unit_code, l.unit_label, l.quantity, l.unit_rate_cents, l.percent_bp,
    l.catalog_rate_cents, l.catalog_percent_bp, l.price_source, l.taxable, l.amount_cents
  from public.quote_lines l
  where l.quote_version_id = v_version.id
  order by l.line_no;
  perform set_config('tlt.order_conversion', 'off', true);

  insert into public.order_status_events (company_id, order_id, from_status, to_status, note, actor_id)
  values (v_company, v_order.id, null, 'confirmed',
          format('Created from quote %s revision %s', v_quote.quote_number, v_version.version_no), auth.uid());

  perform private.log_event('order.created_from_quote', 'order', v_order.id,
    format('%s created from %s (revision %s), total %s', v_order.order_number, v_quote.quote_number,
           v_version.version_no, to_char(v_order.total_cents / 100.0, 'FM999,999,990.00')),
    jsonb_build_object('quote_id', v_quote.id, 'quote_version_id', v_version.id, 'line_count', v_lines));
  perform private.log_event('quote.converted_to_order', 'quote', v_quote.id,
    format('%s converted to order %s', v_quote.quote_number, v_order.order_number),
    jsonb_build_object('order_id', v_order.id));

  return jsonb_build_object('order_id', v_order.id, 'order_number', v_order.order_number, 'created', true);
end;
$function$;

create or replace function private.quote_accepted_create_order()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.create_order_from_quote(new.id);
  return new;
end;
$$;
create trigger quotes_accepted_create_order after update of status on public.quotes
  for each row when (new.status = 'accepted' and old.status is distinct from 'accepted')
  execute function private.quote_accepted_create_order();

create or replace view public.order_fulfillment with (security_invoker = true) as
with loads as (
  select l.order_id, count(*)::int as loads_planned,
         count(*) filter (where l.ends_at > now())::int as loads_upcoming,
         count(*) filter (where l.ends_at <= now() and not exists (
           select 1 from public.delivery_tickets t where t.load_id = l.id and t.company_id = l.company_id and t.status = 'accepted'))::int as loads_without_accepted_ticket
  from public.order_loads l where l.status = 'planned' group by l.order_id
), tickets as (
  select t.order_id,
         count(*) filter (where t.status in ('submitted', 'needs_review'))::int as pending,
         count(*) filter (where t.status = 'accepted')::int as accepted
  from public.delivery_tickets t where t.status <> 'superseded' group by t.order_id
), lines as (
  select ol.order_id,
         count(*) filter (where x.other_unit > 0)::int as lines_other_unit,
         count(*) filter (where x.other_unit = 0 and x.accepted_qty < ol.quantity)::int as lines_short
  from public.order_lines ol
  join lateral (
    select count(*) filter (where t.unit_code is distinct from ol.unit_code) as other_unit,
           coalesce(sum(t.quantity) filter (where t.unit_code = ol.unit_code and t.status = 'accepted'), 0) as accepted_qty,
           count(*) as live
    from public.delivery_tickets t
    where t.order_line_id = ol.id and t.company_id = ol.company_id and t.status in ('submitted', 'needs_review', 'accepted')
  ) x on x.live > 0
  where ol.calc_method = 'per_unit' and ol.kind <> 'discount'
  group by ol.order_id
)
select o.id as order_id, o.company_id,
       coalesce(l.loads_planned, 0) as loads_planned,
       coalesce(l.loads_upcoming, 0) as loads_upcoming,
       coalesce(l.loads_without_accepted_ticket, 0) as loads_without_accepted_ticket,
       coalesce(t.pending, 0) as tickets_pending,
       coalesce(t.accepted, 0) as tickets_accepted,
       coalesce(ln.lines_short, 0) as lines_short,
       coalesce(ln.lines_other_unit, 0) as lines_other_unit,
       (coalesce(l.loads_planned, 0) > 0 and coalesce(l.loads_upcoming, 0) = 0 and coalesce(l.loads_without_accepted_ticket, 0) = 0
        and coalesce(t.pending, 0) = 0 and coalesce(t.accepted, 0) > 0
        and coalesce(ln.lines_short, 0) = 0 and coalesce(ln.lines_other_unit, 0) = 0) as fulfilled,
       case
         when coalesce(l.loads_planned, 0) = 0 then 'no_loads'
         when coalesce(l.loads_upcoming, 0) > 0 then 'loads_upcoming'
         when coalesce(t.pending, 0) > 0 then 'tickets_pending'
         when coalesce(l.loads_without_accepted_ticket, 0) > 0 then 'loads_without_accepted_ticket'
         when coalesce(ln.lines_other_unit, 0) > 0 then 'tickets_other_unit'
         when coalesce(ln.lines_short, 0) > 0 then 'quantity_short'
         when coalesce(t.accepted, 0) = 0 then 'no_accepted_tickets'
       end as gap
from public.orders o
left join loads l on l.order_id = o.id
left join tickets t on t.order_id = o.id
left join lines ln on ln.order_id = o.id;
grant select on public.order_fulfillment to authenticated;

create or replace view public.billing_line_status with (security_invoker = true) as  SELECT ol.id AS line_id,
    ol.company_id,
    ol.order_id,
    o.order_number,
    o.status AS order_status,
    ol.line_no,
    ol.kind,
    ol.description,
    ol.material_id,
    ol.unit_code,
    ol.quantity AS ordered_quantity,
    ol.unit_rate_cents,
    ol.amount_cents,
    ol.price_source,
    COALESCE(t.live_count, 0::bigint)::integer AS live_count,
    COALESCE(t.pending_count, 0::bigint)::integer AS pending_count,
    COALESCE(t.other_unit_count, 0::bigint)::integer AS other_unit_count,
    t.delivered_quantity,
    t.ticket_units,
        CASE
            WHEN o.status <> 'completed'::order_status AND NOT COALESCE(f.fulfilled, false) THEN 'in_progress'::text
            WHEN COALESCE(t.live_count, 0::bigint) = 0 THEN 'no_tickets'::text
            WHEN t.other_unit_count > 0 THEN 'units_differ'::text
            WHEN t.delivered_quantity = ol.quantity THEN 'match'::text
            WHEN t.delivered_quantity > ol.quantity THEN 'over'::text
            ELSE 'under'::text
        END AS quantity_check,
        CASE
            WHEN COALESCE(t.live_count, 0::bigint) > 0 AND t.other_unit_count = 0 THEN t.delivered_quantity - ol.quantity
            ELSE NULL::numeric
        END AS quantity_difference,
        CASE
            WHEN ol.unit_rate_cents = 0 THEN 'zero_rate'::text
            ELSE 'ok'::text
        END AS pricing_check
   FROM order_lines ol
     JOIN orders o ON o.id = ol.order_id AND o.company_id = ol.company_id
     LEFT JOIN order_fulfillment f ON f.order_id = o.id
     LEFT JOIN LATERAL ( SELECT count(*) AS live_count,
            count(*) FILTER (WHERE dt.status = ANY (ARRAY['submitted'::ticket_status, 'needs_review'::ticket_status])) AS pending_count,
            count(*) FILTER (WHERE dt.unit_code IS DISTINCT FROM ol.unit_code) AS other_unit_count,
            sum(dt.quantity) FILTER (WHERE dt.unit_code = ol.unit_code) AS delivered_quantity,
            array_agg(DISTINCT dt.unit_code) AS ticket_units
           FROM delivery_tickets dt
          WHERE dt.order_line_id = ol.id AND dt.company_id = ol.company_id AND (dt.status = ANY (ARRAY['submitted'::ticket_status, 'needs_review'::ticket_status, 'accepted'::ticket_status]))) t ON true
  WHERE ol.calc_method = 'per_unit'::calc_method AND ol.kind <> 'discount'::charge_kind AND (o.status = ANY (ARRAY['scheduled'::order_status, 'dispatched'::order_status, 'in_progress'::order_status, 'partially_completed'::order_status, 'completed'::order_status]));;

create or replace view public.billing_order_status with (security_invoker = true) as  WITH loads AS (
         SELECT billing_load_status.order_id,
            count(*)::integer AS loads_total,
            count(*) FILTER (WHERE billing_load_status.is_due)::integer AS loads_due,
            count(*) FILTER (WHERE billing_load_status.documentation_state = 'missing'::text)::integer AS loads_missing,
            count(*) FILTER (WHERE billing_load_status.documentation_state = 'not_due'::text)::integer AS loads_not_due,
            min(billing_load_status.load_date) AS first_load_date,
            max(billing_load_status.load_date) AS last_load_date
           FROM billing_load_status
          GROUP BY billing_load_status.order_id
        ), tickets AS (
         SELECT delivery_tickets.order_id,
            count(*) FILTER (WHERE delivery_tickets.status = ANY (ARRAY['submitted'::ticket_status, 'needs_review'::ticket_status, 'accepted'::ticket_status]))::integer AS tickets_live,
            count(*) FILTER (WHERE delivery_tickets.status = ANY (ARRAY['submitted'::ticket_status, 'needs_review'::ticket_status]))::integer AS tickets_pending,
            count(*) FILTER (WHERE delivery_tickets.status = 'accepted'::ticket_status)::integer AS tickets_accepted,
            md5(string_agg((delivery_tickets.id::text || ':'::text) || delivery_tickets.status::text, ','::text ORDER BY delivery_tickets.id)) AS documents_fingerprint
           FROM delivery_tickets
          WHERE delivery_tickets.status <> 'superseded'::ticket_status
          GROUP BY delivery_tickets.order_id
        ), exceptions AS (
         SELECT billing_exceptions.order_id,
            count(*)::integer AS exceptions_count,
            md5(string_agg(billing_exceptions.key, ','::text ORDER BY billing_exceptions.key)) AS exceptions_fingerprint
           FROM billing_exceptions
          GROUP BY billing_exceptions.order_id
        ), base AS (
         SELECT o.id AS order_id,
            o.company_id,
            o.order_number,
            o.status,
            o.customer_id,
            c.name AS customer_name,
            c.customer_number,
            o.project_name,
            o.customer_po,
            o.order_date,
            o.scheduled_start,
            o.scheduled_end,
            o.completed_at,
            o.total_cents,
            o.is_sample,
            COALESCE(l.first_load_date, o.scheduled_start) AS service_start,
            COALESCE(l.last_load_date, o.scheduled_end, o.scheduled_start) AS service_end,
            COALESCE(l.loads_total, 0) AS loads_total,
            COALESCE(l.loads_due, 0) AS loads_due,
            COALESCE(l.loads_missing, 0) AS loads_missing,
            COALESCE(l.loads_not_due, 0) AS loads_not_due,
            COALESCE(t.tickets_live, 0) AS tickets_live,
            COALESCE(t.tickets_pending, 0) AS tickets_pending,
            COALESCE(t.tickets_accepted, 0) AS tickets_accepted,
            COALESCE(t.documents_fingerprint, md5(''::text)) AS documents_fingerprint,
            COALESCE(e.exceptions_count, 0) AS exceptions_count,
            COALESCE(e.exceptions_fingerprint, md5(''::text)) AS exceptions_fingerprint
           FROM orders o
             LEFT JOIN customers c ON c.id = o.customer_id AND c.company_id = o.company_id
             LEFT JOIN loads l ON l.order_id = o.id
             LEFT JOIN tickets t ON t.order_id = o.id
             LEFT JOIN exceptions e ON e.order_id = o.id
          WHERE o.status = ANY (ARRAY['scheduled'::order_status, 'dispatched'::order_status, 'in_progress'::order_status, 'partially_completed'::order_status, 'completed'::order_status])
        )
 SELECT b.order_id,
    b.company_id,
    b.order_number,
    b.status,
    b.customer_id,
    b.customer_name,
    b.customer_number,
    b.project_name,
    b.customer_po,
    b.order_date,
    b.scheduled_start,
    b.scheduled_end,
    b.completed_at,
    b.total_cents,
    b.is_sample,
    b.service_start,
    b.service_end,
    b.loads_total,
    b.loads_due,
    b.loads_missing,
    b.loads_not_due,
    b.tickets_live,
    b.tickets_pending,
    b.tickets_accepted,
    b.documents_fingerprint,
    b.exceptions_count,
    b.exceptions_fingerprint,
    r.id AS acknowledgment_id,
    r.decided_by AS acknowledged_by,
    r.decided_at AS acknowledged_at,
    r.reason AS acknowledgment_reason,
    ( SELECT max(x.decided_at) AS max
           FROM billing_reviews x
          WHERE x.order_id = b.order_id AND x.company_id = b.company_id) AS last_acknowledged_at,
    h.id AS handoff_order_id,
    h.handoff_id,
    hb.batch_number,
    hb.reference AS handoff_reference,
    hb.created_at AS handed_off_at,
    hb.created_by AS handed_off_by,
    h.id IS NOT NULL AND h.documents_fingerprint <> b.documents_fingerprint AS changed_since_handoff,
        CASE
            WHEN h.id IS NOT NULL THEN 'handed_off'::text
            WHEN b.loads_missing > 0 OR b.status = 'completed'::order_status AND b.tickets_live = 0 THEN 'missing_documentation'::text
            WHEN b.tickets_pending > 0 THEN 'needs_review'::text
            WHEN b.exceptions_count > 0 AND r.id IS NULL THEN 'blocked'::text
            WHEN b.status <> 'completed'::order_status AND NOT COALESCE(f.fulfilled, false) THEN 'in_progress'::text
            ELSE 'ready'::text
        END AS readiness,
    COALESCE(f.fulfilled, false) AS fulfilled,
    f.gap AS fulfillment_gap
   FROM base b
     LEFT JOIN order_fulfillment f ON f.order_id = b.order_id
     LEFT JOIN LATERAL ( SELECT x.id,
            x.company_id,
            x.order_id,
            x.fingerprint,
            x.exceptions,
            x.reason,
            x.decided_by,
            x.decided_at
           FROM billing_reviews x
          WHERE x.order_id = b.order_id AND x.company_id = b.company_id AND x.fingerprint = b.exceptions_fingerprint
          ORDER BY x.decided_at DESC
         LIMIT 1) r ON b.exceptions_count > 0
     LEFT JOIN billing_handoff_orders h ON h.order_id = b.order_id AND h.company_id = b.company_id AND h.reverted_at IS NULL
     LEFT JOIN billing_handoffs hb ON hb.id = h.handoff_id AND hb.company_id = h.company_id;;

alter table public.company_settings
  add column brand_logo text not null default '' check (brand_logo = '' or (brand_logo ~ '^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$' and length(brand_logo) <= 400000)),
  add column brand_color text not null default '' check (brand_color = '' or brand_color ~ '^#[0-9a-fA-F]{6}$'),
  add column brand_sidebar_color text not null default '' check (brand_sidebar_color = '' or brand_sidebar_color ~ '^#[0-9a-fA-F]{6}$');

revoke execute on function private.load_capacity_problem(uuid, uuid, uuid, numeric, text), private.create_order_from_quote(uuid),
  private.quote_accepted_create_order() from public, anon, authenticated;
revoke execute on function public.reject_dispatch_recommendation(uuid, uuid, uuid, text), public.reconsider_dispatch_recommendations(uuid) from public, anon;
grant execute on function public.reject_dispatch_recommendation(uuid, uuid, uuid, text), public.reconsider_dispatch_recommendations(uuid) to authenticated;
