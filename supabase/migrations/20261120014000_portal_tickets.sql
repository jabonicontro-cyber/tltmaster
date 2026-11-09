-- =============================================================================
-- Customer portal: one list of the customer's delivery tickets (portal Tickets page and its CSV download).
--
-- public.portal_tickets(slug, from, to, site): the signed-in customer's own delivered tickets across their orders,
-- newest first, optionally limited to delivery days (in the company's time zone) and one of their saved job sites.
-- The same rules as the ticket copy the portal already shows (public.portal_ticket):
--   * company and customer come from the signed-in portal account (private.portal_me), never from the caller;
--   * the company's Documents switch must be on (private.portal_require_feature 'documents');
--   * only live tickets (submitted, being checked, accepted) on the customer's own non-draft orders;
--   * no driver, truck, review or internal fields.
-- At most 500 rows; "has_more" says when there were more (the page asks for a narrower date range).
--
-- Additive (one new function). Rollback: supabase/rollbacks/20261120014000_portal_tickets.down.sql.
-- =============================================================================

create or replace function public.portal_tickets(p_slug text, p_from date default null, p_to date default null, p_site uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v public.portal_accounts%rowtype := private.portal_me(p_slug);
  v_tz text;
  v_rows jsonb;
  v_count integer;
begin
  perform private.portal_require_feature(v.company_id, 'documents');
  if p_from is not null and p_to is not null and p_to < p_from then
    raise exception 'The end date is before the start date.' using errcode = '22023';
  end if;
  -- A site filter must be one of this customer's own saved job sites.
  if p_site is not null and not exists (select 1 from public.customer_sites st where st.id = p_site and st.company_id = v.company_id and st.customer_id = v.customer_id) then
    raise exception 'Job site not found.' using errcode = 'P0002';
  end if;
  select coalesce(nullif(cs.timezone, ''), 'America/Chicago') into v_tz from public.company_settings cs where cs.company_id = v.company_id;
  v_tz := coalesce(v_tz, 'America/Chicago');

  with live as (
    select t.id, t.order_id, t.ticket_number, t.delivered_at, t.quantity, t.company_id, t.unit_code, t.status, t.external_reference, t.order_line_id,
           (t.delivered_at at time zone v_tz)::date as delivered_on,
           o.order_number, o.site_id, o.project_name, o.customer_po,
           concat_ws(', ', nullif(o.site_label, ''), nullif(o.site_line1, ''), nullif(o.site_city, '')) as site
    from public.delivery_tickets t
    join public.orders o on o.id = t.order_id and o.company_id = t.company_id
    where t.company_id = v.company_id
      and o.customer_id = v.customer_id
      and o.status <> 'draft'
      and t.status in ('submitted', 'needs_review', 'accepted')
      and (p_site is null or o.site_id = p_site)
      and (p_from is null or (t.delivered_at at time zone v_tz)::date >= p_from)
      and (p_to is null or (t.delivered_at at time zone v_tz)::date <= p_to)
  ), picked as (
    select * from live order by delivered_at desc, ticket_number desc limit 501
  )
  select count(*)::integer,
         coalesce(jsonb_agg(jsonb_build_object(
           'id', p.id, 'order_id', p.order_id, 'order_number', p.order_number, 'number', p.ticket_number,
           'delivered_at', p.delivered_at, 'delivered_on', p.delivered_on,
           'quantity', p.quantity, 'unit', private.portal_unit(p.company_id, p.unit_code),
           'material', (select l.description from public.order_lines l where l.id = p.order_line_id and l.company_id = p.company_id),
           'site', p.site, 'site_id', p.site_id, 'project', coalesce(p.project_name, ''), 'po', coalesce(p.customer_po, ''),
           'reference', coalesce(p.external_reference, ''), 'confirmed', p.status = 'accepted')
           order by p.delivered_at desc, p.ticket_number desc) filter (where p.rn <= 500), '[]'::jsonb)
    into v_count, v_rows
  from (select picked.*, row_number() over (order by delivered_at desc, ticket_number desc) as rn from picked) p;

  return jsonb_build_object('tickets', v_rows, 'has_more', v_count > 500, 'limit', 500,
                            'from', p_from, 'to', p_to, 'site', p_site, 'today', private.business_today(v.company_id));
end;
$$;

revoke all on function public.portal_tickets(text, date, date, uuid) from public, anon;
grant execute on function public.portal_tickets(text, date, date, uuid) to authenticated;

-- Verification: installed as a pinned definer function.
do $$
begin
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and p.proname = 'portal_tickets'
                   and p.prosecdef and 'search_path=""' = any (p.proconfig)) then
    raise exception 'portal_tickets is not installed as expected';
  end if;
end;
$$;
