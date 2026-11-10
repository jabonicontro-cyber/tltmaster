-- =============================================================================
-- QuickBooks during Taviron support visits, and its audit trail (financial review 2026-11-09, finding L3; master plan
-- §12 SEC4).
--
--   * A support visit cannot connect, change or disconnect a company's QuickBooks: a trigger on
--     public.accounting_connections refuses any insert, update or delete made from a visit, whichever function makes it
--     (as 20261120008900 does for the GPS feed key). The app refuses first with the same plain words.
--   * Nothing is sent to QuickBooks during a visit to a real company (owner decision 2026-11-10): claiming or recording a
--     send and matching customers are refused by triggers; the Billing board shows the sends but no Send button.
--   * Connecting, connecting again and disconnecting are recorded in the company's history (audit log): connecting in
--     public.accounting_save_connection (redefined from 20261120003500, its only definition), disconnecting by a trigger
--     after the row is removed (public.accounting_disconnect itself is unchanged).
--   * A connection cannot be pointed at another QuickBooks company without signing in to it: saving a different
--     QuickBooks company id (or environment) for a business that is already connected is refused; the person
--     disconnects first, then connects the other company through Intuit. Before, any billing manager could repoint it
--     with a direct database call, which also dropped the business's customer matches.
--
-- No table, column or row changes. Rollback: supabase/rollbacks/20261120018100_quickbooks_support_visits.down.sql
-- =============================================================================

create or replace function private.forbid_accounting_during_support_visit()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if private.support_company() is not null then
    raise exception 'Taviron support cannot connect, change or disconnect QuickBooks. Ask an owner of the company.'
      using errcode = '42501';
  end if;
  return coalesce(new, old);
end;
$$;
revoke all on function private.forbid_accounting_during_support_visit() from public, anon, authenticated;

create trigger z_no_support_visit before insert or update or delete on public.accounting_connections
  for each row execute function private.forbid_accounting_during_support_visit();

-- Which business a connection belongs to, for history lines ("" for the whole company).
create or replace function private.accounting_business_label(p_company uuid, p_entity uuid)
returns text language sql stable security definer set search_path = '' as $$
  select coalesce((select ' for ' || e.name from public.billing_entities e where e.id = p_entity and e.company_id = p_company), '')
$$;
revoke all on function private.accounting_business_label(uuid, uuid) from public, anon, authenticated;

create or replace function public.accounting_save_connection(p_entity uuid, p_environment text, p_realm text, p_company_name text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v_old public.accounting_connections%rowtype := private.accounting_connection(p_entity);
  v_realm text := left(coalesce(p_realm, ''), 40);
  v_name text := left(coalesce(p_company_name, ''), 200);
  v_id uuid;
begin
  perform private.require_permission('billing.manage');
  if p_environment not in ('sandbox', 'production') or v_realm = '' then
    raise exception 'The QuickBooks connection is incomplete.' using errcode = '22023';
  end if;
  if p_entity is not null and not exists (select 1 from public.billing_entities e where e.id = p_entity and e.company_id = v_company) then
    raise exception 'Business not found.' using errcode = 'P0002';
  end if;
  if v_old.id is null then
    insert into public.accounting_connections (company_id, billing_entity_id, environment, realm_id, company_name, connected_by)
    values (v_company, p_entity, p_environment, v_realm, v_name, auth.uid())
    returning id into v_id;
    perform private.log_event('accounting.connected', 'accounting_connection', v_id,
      'QuickBooks connected' || private.accounting_business_label(v_company, p_entity),
      jsonb_build_object('environment', p_environment, 'business_id', p_entity));
    return v_id;
  end if;
  -- Another QuickBooks company (or environment) for a business that is already connected: disconnect first.
  if v_old.realm_id <> v_realm or v_old.environment <> p_environment then
    raise exception 'This business is already connected to another QuickBooks company. Disconnect it first, then connect the other company.'
      using errcode = '22023';
  end if;
  v_id := v_old.id;
  update public.accounting_connections
     set company_name = v_name, status = 'connected', connected_by = auth.uid(), connected_at = now(), updated_at = now()
   where id = v_id;
  -- The app saves twice when connecting: first without the QuickBooks company's name, then with it.
  if v_old.company_name = '' and v_name <> '' and v_old.status = 'connected' then
    perform private.log_event('accounting.named', 'accounting_connection', v_id,
      'QuickBooks company recorded' || private.accounting_business_label(v_company, p_entity) || ': ' || v_name,
      jsonb_build_object('environment', p_environment, 'business_id', p_entity));
  else
    perform private.log_event('accounting.reconnected', 'accounting_connection', v_id,
      'QuickBooks connected again' || private.accounting_business_label(v_company, p_entity),
      jsonb_build_object('environment', p_environment, 'business_id', p_entity, 'was', v_old.status));
  end if;
  return v_id;
end;
$$;
revoke all on function public.accounting_save_connection(uuid, text, text, text) from public, anon;
grant execute on function public.accounting_save_connection(uuid, text, text, text) to authenticated;

-- Disconnecting (public.accounting_disconnect) is recorded once the row is gone. Only a person working in that company
-- is recorded this way; removals made with no company context (the platform deleting a whole company) are not.
create or replace function private.accounting_connection_removed()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is not null and private.current_company_id() = old.company_id then
    perform private.log_event('accounting.disconnected', 'accounting_connection', old.id,
      'QuickBooks disconnected' || private.accounting_business_label(old.company_id, old.billing_entity_id)
        || case when old.company_name <> '' then ': ' || old.company_name else '' end,
      jsonb_build_object('environment', old.environment, 'business_id', old.billing_entity_id));
  end if;
  return old;
end;
$$;
revoke all on function private.accounting_connection_removed() from public, anon, authenticated;

create trigger accounting_connection_removed after delete on public.accounting_connections
  for each row execute function private.accounting_connection_removed();

-- Nothing is sent to QuickBooks during a Taviron support visit to a real company (owner decision 2026-11-10): a send
-- cannot be claimed or recorded, and no customer match is made or changed. Support still sees what would be sent and
-- what was sent. A demo company's sends are simulated (nothing leaves Taviron), so a visit to a demo can still show them.
create or replace function private.forbid_accounting_send_during_support_visit()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_company uuid := private.support_company();
begin
  if v_company is not null and not exists (select 1 from public.companies c where c.id = v_company and c.is_demo) then
    raise exception 'Taviron support cannot send anything to QuickBooks. Ask someone in the company to send it.'
      using errcode = '42501';
  end if;
  return coalesce(new, old);
end;
$$;
revoke all on function private.forbid_accounting_send_during_support_visit() from public, anon, authenticated;

create trigger z_no_support_visit before insert or update on public.accounting_invoice_sends
  for each row execute function private.forbid_accounting_send_during_support_visit();
create trigger z_no_support_visit before insert or update or delete on public.accounting_customer_links
  for each row execute function private.forbid_accounting_send_during_support_visit();
