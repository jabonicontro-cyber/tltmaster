-- =============================================================================
-- Payroll and sample-data removal (2026-10-19; fixes an interaction found by the full DB suite).
--
-- Settings → Remove sample data (public.remove_sample_data, guarded by the tlt.sample_purge setting) deletes sample
-- orders and, with them, their delivery tickets. A sample ticket already in the payroll ledger (20261118000200) made
-- that removal fail on the foreign key. Now, only during sample removal:
--   - ledger rows of the sample ticket in an open or in-review period are removed with it (an adjustment that named
--     the row keeps its amount and loses only the link), and the removal is audited;
--   - a sample ticket in an approved, exported or reconciled period stops the removal with a clear message, because
--     finalized payroll is never rewritten silently.
-- Outside sample removal nothing changes: the foreign key still refuses to delete a ticket that is in the ledger.
-- Rollback: supabase/rollbacks/20261118000400_payroll_sample_purge.down.sql
-- =============================================================================

create or replace function private.payroll_release_sample_ticket()
 returns trigger
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  v_n integer;
begin
  if coalesce(current_setting('tlt.sample_purge', true), 'off') <> 'on' then
    return old;
  end if;
  if exists (select 1 from public.payroll_entries e join public.payroll_periods p on p.id = e.period_id
             where e.ticket_id = old.id and p.status not in ('open', 'in_review')) then
    raise exception 'Sample ticket % is in an approved payroll period. Payroll that is approved is never changed; remove that period''s sample entries by a correction first.', old.ticket_number
      using errcode = 'P0001';
  end if;
  update public.payroll_adjustments set entry_id = null
   where entry_id in (select id from public.payroll_entries where ticket_id = old.id);
  delete from public.payroll_entries where ticket_id = old.id;
  get diagnostics v_n = row_count;
  if v_n > 0 then
    perform private.log_event('payroll.sample_entries_removed', 'delivery_ticket', old.id,
      format('Sample ticket %s removed from %s open payroll entr%s', old.ticket_number, v_n, case when v_n = 1 then 'y' else 'ies' end),
      jsonb_build_object('ticket_id', old.id, 'entries', v_n));
  end if;
  return old;
end;
$$;
revoke all on function private.payroll_release_sample_ticket() from public, anon, authenticated;

create trigger payroll_release_sample_ticket
  before delete on public.delivery_tickets
  for each row execute function private.payroll_release_sample_ticket();
