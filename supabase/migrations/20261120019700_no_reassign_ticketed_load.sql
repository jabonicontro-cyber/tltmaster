-- =============================================================================
-- A load with a delivery ticket keeps its truck and driver (owner decision 2026-11-12, "Block it"; master plan §12 RL1,
-- from the WK3 walkthrough).
--
-- Dispatch could reassign a delivered, ticketed load. The ticket then named a truck and driver that no longer matched
-- the load on the board, which confuses billing and driver pay. Now, once a load has a live delivery ticket (status
-- submitted, needs review or accepted; a voided ticket, or a superseded revision, does not count), the database refuses
-- to change or remove its truck, trailer and driver, with the reason and the next step (hint 'ticketed_load'):
--   "ORD-1042 load 3 already has delivery ticket TKT-0007, so its truck and driver can no longer be changed. If they
--    are wrong, correct the ticket in Tickets, or void it there and then reassign the load."
--
-- Every path that puts a truck on a load goes through public.assign_load, so the check is made there once:
--   * public.assign_load: refused for a load with a live ticket, whether it is a reassignment (p_replace_assignment_id)
--     or a new assignment of a load whose assignment was removed. Checked after the load row is locked; ticket entry
--     (private.prepare_ticket) locks the same row, so a ticket and a reassignment cannot slip past each other.
--   * public.assign_load_off_shift and public.hauler_offer_confirm call public.assign_load and inherit the refusal
--     (nothing of theirs is kept: the whole call is rolled back). Not changed.
--   * public.cancel_assignment (remove the truck and driver, the first half of a manual reassignment): refused the same
--     way. It now locks the load row first, as ticket entry and assign_load do.
-- Not changed: canceling a load or its order (already refused while it has live tickets, private.guard_load_with_tickets),
-- an order put on hold or back to Confirmed (releases only assignments that have not ended), releasing a truck-for-the-
-- day slot (ends the assignment, keeps the truck), and moving a load's times (public.save_order_load).
--
-- Loads without a live ticket are unaffected: a load whose earlier assignment ended or was removed without a ticket, or
-- whose tickets were all voided, is assigned and reassigned as before. Truck-for-the-day slots follow the same rule:
-- once a trip ticket is entered, swap the truck by releasing it and adding another truck for the day.
--
-- How: private.refuse_ticketed_load(company, load, action) raises the refusal (not a security definer function; it
-- runs inside the two definer functions, which already checked dispatch.edit and the caller's company). For a person
-- limited to some dispatch bases it stays silent about another base's load, which the base rule refuses as before, so
-- that load's ticket numbers are never named to them. The two
-- functions are taken from their installed definitions and given their new lines; each anchor must appear exactly
-- once, or the migration stops and changes nothing. Signatures and execute rights are unchanged.
-- Functions only: no tables, no rows.
-- Reversible: supabase/rollbacks/20261120019700_no_reassign_ticketed_load.down.sql
-- =============================================================================

create or replace function private.refuse_ticketed_load(p_company uuid, p_load uuid, p_action text)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_numbers text[];
  v_label   text;
  v_one     boolean;
  v_list    text;
  v_bases   uuid[];
begin
  select array_agg(t.ticket_number order by t.ticket_number) into v_numbers
  from public.delivery_tickets t
  where t.company_id = p_company and t.load_id = p_load and t.status in ('submitted', 'needs_review', 'accepted');
  if v_numbers is null then
    return;
  end if;
  -- A person limited to some dispatch bases is refused another base's load by the base rule (private.base_write_guard,
  -- when the assignment is written); this check never names that load's tickets to them.
  v_bases := private.my_bases();
  if v_bases is not null and exists (
    select 1 from public.order_loads l join public.orders o on o.id = l.order_id and o.company_id = l.company_id
    where l.id = p_load and l.company_id = p_company and o.base_id is not null and not (o.base_id = any (v_bases)))
  then
    return;
  end if;
  select format('%s load %s', o.order_number, l.load_number) into v_label
  from public.order_loads l join public.orders o on o.id = l.order_id and o.company_id = l.company_id
  where l.id = p_load and l.company_id = p_company;
  v_one := cardinality(v_numbers) = 1;
  v_list := case when cardinality(v_numbers) <= 3 then array_to_string(v_numbers, ', ')
                 else format('%s and %s more', array_to_string(v_numbers[1:3], ', '), cardinality(v_numbers) - 3) end;
  raise exception '% already has %, so its truck and driver can no longer be %. If they are wrong, correct % in Tickets, or void % there%.',
    coalesce(v_label, 'This load'),
    case when v_one then 'delivery ticket ' else 'delivery tickets ' end || v_list,
    case when p_action = 'remove' then 'removed' else 'changed' end,
    case when v_one then 'the ticket' else 'the tickets' end,
    case when v_one then 'it' else 'them' end,
    case when p_action = 'remove' then ' first' else ' and then reassign the load' end
    using errcode = '22023', hint = 'ticketed_load';
end;
$$;
comment on function private.refuse_ticketed_load(uuid, uuid, text) is
  'RL1 (owner 2026-11-12): raises when the load has a live delivery ticket (submitted, needs review, accepted); p_action change or remove.';
revoke all on function private.refuse_ticketed_load(uuid, uuid, text) from public, anon, authenticated;

do $$
declare
  v_fn    regprocedure;
  v_def   text;
  v_patch record;
begin
  for v_patch in
    select * from (values
      ('public.assign_load(uuid, uuid, uuid, uuid, text, uuid, text)',
       '  -- Credit hold (B128, financial review L2): going ahead for a customer on hold needs a reason, recorded below.',
       '  -- Delivery ticket (RL1, owner 2026-11-12): a load with a live ticket keeps its truck and driver.
  perform private.refuse_ticketed_load(v_company, v_load.id, ''change'');

  -- Credit hold (B128, financial review L2): going ahead for a customer on hold needs a reason, recorded below.'),
      ('public.cancel_assignment(uuid, text)',
       '  if length(v_reason) = 0 then raise exception ''Enter a reason for removing the assignment.''; end if;',
       '  if length(v_reason) = 0 then raise exception ''Enter a reason for removing the assignment.''; end if;
  -- Delivery ticket (RL1, owner 2026-11-12): a load with a live ticket keeps its truck and driver. The load row is
  -- locked first, as ticket entry and assign_load do.
  perform 1 from public.order_loads where id = v_a.load_id and company_id = v_company for update;
  perform private.refuse_ticketed_load(v_company, v_a.load_id, ''remove'');')
    ) as t(sig, old_text, new_text)
  loop
    v_fn := v_patch.sig::regprocedure;
    v_def := pg_get_functiondef(v_fn);
    if position('private.refuse_ticketed_load' in v_def) > 0 then
      continue; -- already changed (re-run)
    end if;
    if (length(v_def) - length(replace(v_def, v_patch.old_text, ''))) / length(v_patch.old_text) <> 1 then
      raise exception '% is not the version this migration expects (a line was not found exactly once).', v_patch.sig;
    end if;
    execute replace(v_def, v_patch.old_text, v_patch.new_text);
  end loop;
end;
$$;

-- Verification: both functions refuse ticketed loads and are still pinned security definer functions.
do $$
begin
  if position('private.refuse_ticketed_load(v_company, v_load.id, ''change'')' in
              pg_get_functiondef('public.assign_load(uuid, uuid, uuid, uuid, text, uuid, text)'::regprocedure)) = 0
     or position('private.refuse_ticketed_load(v_company, v_a.load_id, ''remove'')' in
              pg_get_functiondef('public.cancel_assignment(uuid, text)'::regprocedure)) = 0 then
    raise exception 'A dispatch function does not refuse loads with delivery tickets.';
  end if;
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('assign_load', 'cancel_assignment')
      and not (p.prosecdef and coalesce(p.proconfig, '{}') @> array['search_path=""']))
  then
    raise exception 'A changed function is not a pinned security definer function.';
  end if;
end;
$$;
