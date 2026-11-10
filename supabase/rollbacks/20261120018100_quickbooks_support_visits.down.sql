-- Rollback of 20261120018100_quickbooks_support_visits.sql (not a migration; run by hand after a backup). Removes the
-- support-visit triggers (connections, sends, customer matches) and the disconnect trigger and restores
-- public.accounting_save_connection as 20261120003500 defined it (no history lines; another QuickBooks company id
-- replaces the old one and drops the business's customer matches). History lines already written stay. No rows change.
begin;

drop trigger if exists z_no_support_visit on public.accounting_connections;
drop trigger if exists accounting_connection_removed on public.accounting_connections;
drop trigger if exists z_no_support_visit on public.accounting_invoice_sends;
drop trigger if exists z_no_support_visit on public.accounting_customer_links;

create or replace function public.accounting_save_connection(p_entity uuid, p_environment text, p_realm text, p_company_name text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v_old public.accounting_connections%rowtype := private.accounting_connection(p_entity);
  v_id uuid;
begin
  perform private.require_permission('billing.manage');
  if p_environment not in ('sandbox', 'production') or coalesce(p_realm, '') = '' then
    raise exception 'The QuickBooks connection is incomplete.' using errcode = '22023';
  end if;
  if p_entity is not null and not exists (select 1 from public.billing_entities e where e.id = p_entity and e.company_id = v_company) then
    raise exception 'Business not found.' using errcode = 'P0002';
  end if;
  if v_old.id is null then
    insert into public.accounting_connections (company_id, billing_entity_id, environment, realm_id, company_name, connected_by)
    values (v_company, p_entity, p_environment, left(p_realm, 40), left(coalesce(p_company_name, ''), 200), auth.uid())
    returning id into v_id;
  else
    v_id := v_old.id;
    update public.accounting_connections
       set environment = p_environment, realm_id = left(p_realm, 40), company_name = left(coalesce(p_company_name, ''), 200),
           status = 'connected', connected_by = auth.uid(), connected_at = now(), updated_at = now(),
           item_id = case when v_old.realm_id = left(p_realm, 40) then item_id end,
           item_name = case when v_old.realm_id = left(p_realm, 40) then item_name else '' end
     where id = v_id;
    if v_old.realm_id <> left(p_realm, 40) then
      delete from public.accounting_customer_links l where l.connection_id = v_id;
    end if;
  end if;
  return v_id;
end;
$$;
revoke all on function public.accounting_save_connection(uuid, text, text, text) from public, anon;
grant execute on function public.accounting_save_connection(uuid, text, text, text) to authenticated;

drop function if exists private.accounting_connection_removed();
drop function if exists private.accounting_business_label(uuid, uuid);
drop function if exists private.forbid_accounting_during_support_visit();
drop function if exists private.forbid_accounting_send_during_support_visit();

commit;
