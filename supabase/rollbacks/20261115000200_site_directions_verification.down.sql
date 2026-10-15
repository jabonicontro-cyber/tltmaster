-- Rollback of 20261115000200_site_directions_verification.sql (not a migration; run by hand with a backup first).
-- Drops the verification fields (their history stays in the audit log) and restores driver_assignments.
begin;
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
                                      'state', o.site_state, 'postal_code', o.site_postal_code, 'directions', cs.directions),
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
drop function if exists public.verify_site_directions(uuid);
drop trigger if exists customer_sites_directions_guard on public.customer_sites;
drop function if exists private.guard_site_directions();
drop function if exists private.site_directions_status(public.customer_sites);
alter table public.company_settings drop column if exists site_review_days_standard, drop column if exists site_review_days_safety;
alter table public.customer_sites drop column if exists directions_verified_by, drop column if exists directions_verified_at, drop column if exists directions_risk;
commit;
