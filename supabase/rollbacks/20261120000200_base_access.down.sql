-- Rollback of 20261120000200_base_access (not a migration). Everyone regains every base; the limits are removed.
-- The order and driver list views go back to their columns without base_id.
drop view public.order_list;
create view public.order_list with (security_invoker = true) as
 SELECT o.id,
    o.order_number,
    o.status,
    o.customer_id,
    c.name AS customer_name,
    c.customer_number,
    o.source_quote_id,
    q.quote_number AS source_quote_number,
    o.project_name,
    o.site_label,
    o.site_line1,
    o.site_city,
    o.customer_po,
    o.total_cents,
    o.is_sample,
    o.created_at,
    o.company_id,
    o.order_date,
    o.requested_date,
    o.scheduled_start,
    o.scheduled_end,
    o.window_start,
    o.window_end,
    o.contact_name,
    o.status_note,
    o.updated_at,
    ( SELECT string_agg(l.description, ', '::text ORDER BY l.line_no) AS string_agg
           FROM order_lines l
          WHERE l.order_id = o.id AND l.kind = 'material'::charge_kind) AS material_summary
   FROM orders o
     JOIN customers c ON c.id = o.customer_id
     LEFT JOIN quotes q ON q.id = o.source_quote_id;
revoke all on public.order_list from anon, authenticated;
grant select on public.order_list to authenticated;

drop view public.driver_list;
create view public.driver_list with (security_invoker = true) as
 SELECT d.id,
    d.company_id,
    d.user_id,
    COALESCE(
        CASE
            WHEN c.is_demo THEN NULLIF(TRIM(BOTH FROM d.name), ''::text)
            ELSE NULL::text
        END, NULLIF(TRIM(BOTH FROM ms.full_name), ''::text), NULLIF(d.name, ''::text), 'Unnamed driver'::text) AS display_name,
    d.name,
    d.employee_number,
    d.phone,
    d.hire_date,
    d.active,
    d.notes,
    d.created_at,
    d.updated_at,
    ms.active AS account_active,
    ms.role AS account_role
   FROM drivers d
     LEFT JOIN companies c ON c.id = d.company_id
     LEFT JOIN LATERAL private.member_summary(d.user_id) ms(full_name, active, role) ON d.user_id IS NOT NULL;
revoke all on public.driver_list from anon, authenticated;
grant select on public.driver_list to authenticated;

drop policy if exists trucks_base_access on public.trucks;
drop policy if exists trailers_base_access on public.trailers;
drop policy if exists drivers_base_access on public.drivers;
drop policy if exists orders_base_access on public.orders;
alter table public.company_settings drop column if exists cross_base_dispatch;
drop function if exists public.dispatch_base_allowance();
drop function if exists public.set_order_base(uuid, uuid);
revoke insert (base_id), update (base_id) on public.trucks, public.trailers, public.drivers from authenticated;
drop function if exists public.set_person_bases(uuid, uuid[]);
drop function if exists private.base_unrestricted();
drop function if exists private.my_bases();
drop table if exists public.base_members;
