-- Reverses supabase/migrations/20261031000200_driver_home_own_tickets.sql (restores the 20261018000100 definition).
-- NOT a migration: run by hand, only after a backup and only if the founder asks.
CREATE OR REPLACE FUNCTION public.driver_portal_home()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_d     public.drivers%rowtype := private.portal_driver();
  v_today date := private.business_today(v_d.company_id);
begin
  return jsonb_build_object(
    'driver', jsonb_build_object('name', coalesce((select nullif(trim(p.full_name), '') from public.profiles p where p.id = v_d.user_id),
                                                  nullif(trim(v_d.name), ''), 'Driver')),
    'today', v_today,
    'timezone', private.business_timezone(v_d.company_id),
    'assignments', coalesce((
      select jsonb_agg(x.data order by x.starts_at)
      from private.driver_assignments(v_d.company_id, v_d.id, v_today - 2, v_today + 1) x
      where x.load_date >= v_today or not x.has_live_ticket), '[]'),
    'tickets', coalesce((
      select jsonb_agg(jsonb_build_object('id', t.id, 'number', t.ticket_number, 'revision', t.revision, 'status', t.status,
                                          'quantity', t.quantity, 'unit_code', t.unit_code, 'delivered_at', t.delivered_at,
                                          'order_number', t.snapshot ->> 'order_number', 'load_number', t.snapshot ->> 'load_number',
                                          'review_reasons', to_jsonb(t.review_reasons)) order by t.created_at desc)
      from (select * from public.delivery_tickets t
            where t.company_id = v_d.company_id and t.status <> 'superseded'
              and (t.driver_id = v_d.id or t.created_by = auth.uid())
            order by t.created_at desc limit 10) t), '[]'),
    'qualifications', coalesce((
      select jsonb_agg(jsonb_build_object('kind', q.kind, 'cdl_class', q.cdl_class, 'expires_on', q.expires_on,
                                          'verified', q.verified_at is not null, 'description', q.description) order by q.kind, q.expires_on)
      from public.driver_qualifications q where q.company_id = v_d.company_id and q.driver_id = v_d.id), '[]'),
    'reports', coalesce((
      select jsonb_agg(jsonb_build_object('id', r.id, 'kind', r.kind, 'status', r.status, 'created_at', r.created_at,
                                          'order_number', r.snapshot ->> 'order_number', 'load_number', r.snapshot ->> 'load_number',
                                          'equipment_unit', case r.equipment when 'truck' then r.snapshot ->> 'truck_unit'
                                                                             when 'trailer' then r.snapshot ->> 'trailer_unit' end)
                       order by r.created_at desc)
      from (select * from public.field_reports r
            where r.company_id = v_d.company_id and r.driver_id = v_d.id
            order by r.created_at desc limit 10) r), '[]'));
end;
$function$

;
