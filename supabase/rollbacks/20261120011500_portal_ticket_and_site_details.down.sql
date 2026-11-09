-- Rollback of 20261120011500_portal_ticket_and_site_details: portal_support_link_options and portal_sites return to their
-- earlier definitions (tickets with their number only; sites with a count of waiting notes).
begin;
CREATE OR REPLACE FUNCTION public.portal_support_link_options(p_slug text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v public.portal_accounts%rowtype := private.portal_me(p_slug);
begin
  perform private.portal_require_feature(v.company_id, 'support');
  return jsonb_build_object(
    'orders', (select coalesce(jsonb_agg(jsonb_build_object('id', o.id, 'label', o.order_number) order by o.created_at desc), '[]'::jsonb)
               from (select * from public.orders where company_id = v.company_id and customer_id = v.customer_id and status <> 'draft' order by created_at desc limit 50) o),
    'tickets', (select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'label', t.ticket_number) order by t.created_at desc), '[]'::jsonb)
                from (select t.* from public.delivery_tickets t join public.orders o on o.id = t.order_id and o.company_id = t.company_id
                      where t.company_id = v.company_id and o.customer_id = v.customer_id and t.status <> 'superseded' order by t.created_at desc limit 50) t),
    'invoices', (select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'label', i.number) order by i.created_at desc), '[]'::jsonb)
                 from (select * from public.invoices where company_id = v.company_id and customer_id = v.customer_id and status <> 'draft' order by created_at desc limit 50) i));
end;
$function$

;
CREATE OR REPLACE FUNCTION public.portal_sites(p_slug text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v public.portal_accounts%rowtype := private.portal_me(p_slug);
begin
  return (select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'label', s.label, 'address', concat_ws(', ', nullif(s.line1, ''), nullif(s.city, '')),
                                                        'pending', (select count(*) from public.site_info_submissions x where x.site_id = s.id and x.status = 'pending'))
                                    order by s.label), '[]'::jsonb)
            from public.customer_sites s
           where s.company_id = v.company_id and s.customer_id = v.customer_id and s.active);
end;
$function$

;
commit;
