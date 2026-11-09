-- Customer portal details (owner 2026-11-09), read only through the portal_* functions (docs/CUSTOMER_PORTAL.md):
--   * portal_support_link_options: each ticket also carries its delivered time, quantity and unit, so the support form's
--     ticket picker shows "TKT-1025 · Nov 8 · 14.1 Tons" for every ticket, not only for one order's tickets.
--   * portal_sites: each site also lists its notes still waiting for the office (gate code, drop spot, contact, notes,
--     photo count and when it was sent), so the customer sees what they sent after a reload, not only a count.
-- Strictly the signed-in customer's own records (private.portal_me decides the company and customer, as before); the
-- same tickets and sites as before, with more fields. Nothing else changes.
-- Reversible: supabase/rollbacks/20261120011500_portal_ticket_and_site_details.down.sql

create or replace function public.portal_support_link_options(p_slug text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v public.portal_accounts%rowtype := private.portal_me(p_slug);
begin
  perform private.portal_require_feature(v.company_id, 'support');
  return jsonb_build_object(
    'orders', (select coalesce(jsonb_agg(jsonb_build_object('id', o.id, 'label', o.order_number) order by o.created_at desc), '[]'::jsonb)
               from (select * from public.orders where company_id = v.company_id and customer_id = v.customer_id and status <> 'draft' order by created_at desc limit 50) o),
    'tickets', (select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'label', t.ticket_number, 'delivered_at', t.delivered_at,
                                                             'quantity', t.quantity, 'unit', private.portal_unit(t.company_id, t.unit_code))
                                          order by t.created_at desc), '[]'::jsonb)
                from (select t.* from public.delivery_tickets t join public.orders o on o.id = t.order_id and o.company_id = t.company_id
                      where t.company_id = v.company_id and o.customer_id = v.customer_id and t.status <> 'superseded' order by t.created_at desc limit 50) t),
    'invoices', (select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'label', i.number) order by i.created_at desc), '[]'::jsonb)
                 from (select * from public.invoices where company_id = v.company_id and customer_id = v.customer_id and status <> 'draft' order by created_at desc limit 50) i));
end;
$$;

create or replace function public.portal_sites(p_slug text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v public.portal_accounts%rowtype := private.portal_me(p_slug);
begin
  return (select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'label', s.label, 'address', concat_ws(', ', nullif(s.line1, ''), nullif(s.city, '')),
                                                        'pending', (select count(*) from public.site_info_submissions x where x.site_id = s.id and x.status = 'pending'),
                                                        'pending_notes', (
                                                          select coalesce(jsonb_agg(jsonb_build_object(
                                                                   'id', x.id, 'gate_code', x.gate_code, 'drop_spot', x.drop_spot,
                                                                   'contact_name', x.contact_name, 'contact_phone', x.contact_phone, 'notes', x.notes,
                                                                   'photos', (select count(*) from public.site_photos p
                                                                              where p.submission_id = x.id and p.company_id = x.company_id and p.status <> 'declined'),
                                                                   'created_at', x.submitted_at) order by x.submitted_at desc), '[]'::jsonb)
                                                          from public.site_info_submissions x
                                                          where x.site_id = s.id and x.company_id = v.company_id and x.customer_id = v.customer_id
                                                            and x.status = 'pending'))
                                    order by s.label), '[]'::jsonb)
            from public.customer_sites s
           where s.company_id = v.company_id and s.customer_id = v.customer_id and s.active);
end;
$$;
