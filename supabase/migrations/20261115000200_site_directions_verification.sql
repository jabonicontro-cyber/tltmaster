-- =============================================================================
-- Site directions verification (2026-10-15, master plan B51; owner directive §4.9).
--
-- Directions at a customer site (gate codes, access, where to dump, hazards) can be out of date. Each site now records
-- when its directions were last verified and by whom, and whether they are safety/access-critical:
--   * customer_sites.directions_risk: 'standard' | 'safety_access' (set by people with customers.edit).
--   * directions_verified_at / directions_verified_by: set only through public.verify_site_directions (customers.edit),
--     audited; a trigger refuses direct changes and clears the verification whenever the directions text changes.
--   * company_settings.site_review_days_standard / site_review_days_safety: how often each kind should be re-verified.
--     NULL = no interval (Taviron does not invent one; the company chooses). Unverified safety/access directions are
--     flagged regardless.
--   * private.site_directions_status(site): 'none' | 'unverified' | 'due' | 'verified' — shown to dispatch and drivers.
-- Rollback: supabase/rollbacks/20261115000200_site_directions_verification.down.sql
-- =============================================================================

alter table public.customer_sites
  add column directions_risk text not null default 'standard' check (directions_risk in ('standard', 'safety_access')),
  add column directions_verified_at timestamptz,
  add column directions_verified_by uuid references auth.users (id) on delete set null;

alter table public.company_settings
  add column site_review_days_standard integer check (site_review_days_standard between 1 and 3650),
  add column site_review_days_safety integer check (site_review_days_safety between 1 and 3650);
-- company_settings has column-level update grants (row access still needs settings.manage through RLS).
grant update (site_review_days_standard, site_review_days_safety) on public.company_settings to authenticated;

-- Verification fields change only through verify_site_directions; new or changed directions are unverified.
create or replace function private.guard_site_directions()
 returns trigger
 language plpgsql
 set search_path to ''
as $$
begin
  if coalesce(current_setting('taviron.site_verify', true), '') <> 'on' then
    if tg_op = 'INSERT' then
      new.directions_verified_at := null;
      new.directions_verified_by := null;
    else
      new.directions_verified_at := old.directions_verified_at;
      new.directions_verified_by := old.directions_verified_by;
    end if;
  end if;
  if tg_op = 'UPDATE' and new.directions is distinct from old.directions then
    new.directions_verified_at := null;
    new.directions_verified_by := null;
  end if;
  return new;
end;
$$;
revoke all on function private.guard_site_directions() from public, anon, authenticated;
create trigger customer_sites_directions_guard before insert or update on public.customer_sites
  for each row execute function private.guard_site_directions();

create or replace function private.site_directions_status(p_site public.customer_sites)
 returns text
 language sql
 stable
 set search_path to ''
as $$
  select case
    when p_site.id is null or coalesce(trim(p_site.directions), '') = '' then 'none'
    when p_site.directions_verified_at is null then 'unverified'
    when (select case when p_site.directions_risk = 'safety_access' then s.site_review_days_safety else s.site_review_days_standard end
            from public.company_settings s where s.company_id = p_site.company_id) is not null
         and p_site.directions_verified_at < now() - make_interval(days => (
           select case when p_site.directions_risk = 'safety_access' then s.site_review_days_safety else s.site_review_days_standard end
             from public.company_settings s where s.company_id = p_site.company_id))
      then 'due'
    else 'verified'
  end;
$$;
revoke all on function private.site_directions_status(public.customer_sites) from public, anon, authenticated;

/** Record that a person checked the site's directions today (customers.edit). Audited. */
create or replace function public.verify_site_directions(p_site uuid)
 returns timestamptz
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  v_company uuid := private.require_company();
  v_site    public.customer_sites%rowtype;
begin
  perform private.require_permission('customers.edit');
  select * into v_site from public.customer_sites where id = p_site and company_id = v_company for update;
  if not found then
    raise exception 'Site not found.' using errcode = 'P0002';
  end if;
  if coalesce(trim(v_site.directions), '') = '' then
    raise exception 'This site has no directions to verify.' using errcode = 'P0001';
  end if;
  perform set_config('taviron.site_verify', 'on', true);
  update public.customer_sites set directions_verified_at = now(), directions_verified_by = auth.uid() where id = p_site;
  perform set_config('taviron.site_verify', '', true);
  perform private.log_event('site_directions_verified', 'customer_site', p_site, 'Site directions verified: ' || v_site.label, '{}'::jsonb);
  return now();
end;
$$;
revoke all on function public.verify_site_directions(uuid) from public, anon;
grant execute on function public.verify_site_directions(uuid) to authenticated;

-- My Day: the driver sees whether the site's directions are verified (status, kind and date only).
CREATE OR REPLACE FUNCTION private.driver_assignments(p_company uuid, p_driver uuid, p_from date, p_to date, p_assignment uuid DEFAULT NULL::uuid)
 RETURNS TABLE(assignment_id uuid, starts_at timestamp with time zone, load_date date, has_live_ticket boolean, data jsonb)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select a.id, l.starts_at, l.load_date,
         exists (select 1 from public.delivery_tickets t
                 where t.load_id = l.id and t.company_id = l.company_id and t.status in ('submitted', 'needs_review', 'accepted')),
         jsonb_build_object(
           'assignment_id', a.id,
           'assignment_note', a.note,
           'load', jsonb_build_object('id', l.id, 'number', l.load_number, 'date', l.load_date, 'start_time', l.start_time,
                                      'end_time', l.end_time, 'planned_quantity', l.planned_quantity, 'unit_code', l.unit_code,
                                      'notes', l.notes),
           'order', jsonb_build_object('number', o.order_number, 'status', o.status, 'customer_name', c.name,
                                       'project_name', o.project_name, 'customer_po', o.customer_po,
                                       'contact_name', o.contact_name, 'contact_phone', o.contact_phone,
                                       'job_instructions', o.job_instructions),
           'site', jsonb_build_object('label', o.site_label, 'line1', o.site_line1, 'line2', o.site_line2, 'city', o.site_city,
                                      'state', o.site_state, 'postal_code', o.site_postal_code, 'directions', cs.directions,
                                      'directions_status', private.site_directions_status(cs), 'directions_risk', cs.directions_risk,
                                      'directions_verified_at', cs.directions_verified_at),
           'truck', tr.unit_number,
           'trailer', tl.unit_number,
           'tickets', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'number', t.ticket_number, 'status', t.status,
                                                                    'quantity', t.quantity, 'unit_code', t.unit_code) order by t.ticket_number)
                                from public.delivery_tickets t
                                where t.load_id = l.id and t.company_id = l.company_id
                                  and t.status in ('submitted', 'needs_review', 'accepted')), '[]'),
           'can_submit_ticket', l.load_date <= private.business_today(p_company)
             and o.status in ('scheduled', 'dispatched', 'in_progress', 'partially_completed', 'completed'))
  from public.dispatch_assignments a
  join public.order_loads l on l.id = a.load_id and l.company_id = a.company_id
  join public.orders o on o.id = l.order_id and o.company_id = l.company_id
  left join public.customers c on c.id = o.customer_id and c.company_id = o.company_id
  left join public.customer_sites cs on cs.id = o.site_id and cs.company_id = o.company_id
  left join public.trucks tr on tr.id = a.truck_id and tr.company_id = a.company_id
  left join public.trailers tl on tl.id = a.trailer_id and tl.company_id = a.company_id
  where a.company_id = p_company and a.driver_id = p_driver and a.status = 'active' and l.status = 'planned'
    and l.load_date between p_from and p_to
    and o.status in ('scheduled', 'dispatched', 'in_progress', 'partially_completed', 'completed')
    and (p_assignment is null or a.id = p_assignment)
$function$;
