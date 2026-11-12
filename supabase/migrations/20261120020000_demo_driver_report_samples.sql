-- =============================================================================
-- Sample driver reports for demo companies (demo parity, standing rule; master plan §12 DP1).
--
-- Driver Reports (field reports) had no samples (docs/DEMO_TENANTS.md §4): a report is filed by a driver login, and the
-- demo's fictional drivers have none, so "Not resolved", the Command Center's report items and the shop's equipment
-- reports were empty in every demo mode. public.demo_field_report_samples() adds four reports from the demo's
-- fictional drivers on their own recent loads, the way a driver's phone would have sent them:
--   1. a breakdown on a truck, not resolved (today's load when there is one);
--   2. a delay, acknowledged by the person running the samples, with the note the office added;
--   3. an equipment problem (on the trailer when the load has one), resolved with how it was fixed;
--   4. an edge case: "can't finish the load" from an earlier day, still not acknowledged.
-- and, for each demo owner who drives relief (their own driver record, src/server/demo/samples.ts ownerDriverDay) and
-- has never sent a report, one open equipment problem on their own load from two days ago to tomorrow, so the Driver
-- and "Dispatcher who also drives" modes show it under My reports (a prospect owner added later gets theirs at the next
-- Refresh, whoever runs it).
-- Rules, as the other demo samples (demo_safety_samples, 20261120004300):
--   * Only in a demo company, only by its owner (private.demo_owner_company()); refused otherwise.
--   * Once: the four reports once per demo (they carry 'sample': true in their snapshot, as every report made here
--     does); an owner's own report once per owner (only while their driver record has no report at all). A second run
--     adds nothing. A demo with no recent load for a fictional driver gets the four at a later Refresh.
--   * Never a hired truck's driver; never a driver who is not a member of the demo.
--   * Same table, checks and triggers as a real report: the breakdown raises the in-app alert like any breakdown
--     (no email, text or push), and nothing changes a truck's service status or a load.
--   * Sample reports go with their sample order when sample data is removed (field_reports.order_id cascades).
--
-- Additive: one new function and two private helpers; no table, column or existing row changes.
-- Rollback: supabase/rollbacks/20261120020000_demo_driver_report_samples.down.sql
-- =============================================================================

-- A recent active assignment of a fictional driver for one sample: not already used, another driver first, a trailer
-- when asked, a load that has started first, newest first. Called only from demo_field_report_samples (not by app users).
create or replace function private.demo_report_assignment(p_company uuid, p_from date, p_to date, p_used uuid[], p_trailer boolean)
returns uuid
language sql
stable
set search_path = ''
as $$
  select a.id
  from public.dispatch_assignments a
  join public.order_loads l on l.id = a.load_id and l.company_id = a.company_id
  join public.orders o on o.id = l.order_id and o.company_id = a.company_id
  join public.drivers d on d.id = a.driver_id and d.company_id = a.company_id
  where a.company_id = p_company
    and a.status = 'active'
    and a.truck_id is not null
    and l.status = 'planned'
    and l.load_date between p_from and p_to
    and o.status not in ('draft', 'canceled', 'on_hold')
    and d.active and d.user_id is null and d.hauler_id is null
    and not (a.id = any (p_used))
  order by (a.driver_id in (select x.driver_id from public.dispatch_assignments x where x.id = any (p_used))),
           (p_trailer and a.trailer_id is null),
           (l.starts_at > now()),
           l.load_date desc, l.starts_at desc, a.id
  limit 1
$$;
revoke all on function private.demo_report_assignment(uuid, date, date, uuid[], boolean) from public, anon, authenticated;

-- One sample report on that assignment, with the snapshot a driver's report records (public.driver_submit_field_report)
-- plus the sample mark. Times are kept in the past: sent about 45 minutes into the load (never later than 30 minutes
-- ago), acknowledged 12 minutes later, resolved two hours later (never later than 5 minutes ago).
create or replace function private.demo_report_add(p_assignment uuid, p_kind text, p_equipment text, p_description text,
                                                   p_status text, p_note text, p_by uuid)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_a  public.dispatch_assignments%rowtype;
  v_l  public.order_loads%rowtype;
  v_o  public.orders%rowtype;
  v_at timestamptz;
  v_id uuid;
begin
  select * into v_a from public.dispatch_assignments where id = p_assignment;
  select * into v_l from public.order_loads where id = v_a.load_id;
  select * into v_o from public.orders where id = v_l.order_id;
  v_at := least(now() - interval '30 minutes', coalesce(v_l.starts_at, now()) + interval '45 minutes');
  insert into public.field_reports (company_id, kind, status, driver_id, assignment_id, load_id, order_id, equipment, truck_id, trailer_id,
                                    description, snapshot, reported_by, created_at,
                                    acknowledged_by, acknowledged_at, acknowledge_note, resolved_by, resolved_at, resolution_note)
  values (v_a.company_id, p_kind, p_status, v_a.driver_id, v_a.id, v_l.id, v_o.id, p_equipment,
          case when p_equipment in ('truck', '') then v_a.truck_id end,
          case when p_equipment in ('trailer', '') then v_a.trailer_id end,
          p_description,
          jsonb_build_object('order_number', v_o.order_number, 'load_number', v_l.load_number, 'load_date', v_l.load_date,
                             'customer_name', (select c.name from public.customers c where c.id = v_o.customer_id),
                             'truck_unit', (select t.unit_number from public.trucks t where t.id = v_a.truck_id),
                             'trailer_unit', (select t.unit_number from public.trailers t where t.id = v_a.trailer_id),
                             'driver_name', coalesce((select nullif(trim(d.name), '') from public.drivers d where d.id = v_a.driver_id), 'Driver'),
                             'sample', true),
          null, v_at,
          case when p_status in ('acknowledged', 'resolved') then p_by end,
          case when p_status in ('acknowledged', 'resolved') then v_at + interval '12 minutes' end,
          case when p_status = 'acknowledged' then p_note else '' end,
          case when p_status = 'resolved' then p_by end,
          case when p_status = 'resolved' then least(now() - interval '5 minutes', v_at + interval '2 hours') end,
          case when p_status = 'resolved' then p_note else '' end)
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function private.demo_report_add(uuid, text, text, text, text, text, uuid) from public, anon, authenticated;

create or replace function public.demo_field_report_samples()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_demo  uuid := private.demo_owner_company();
  v_today date;
  v_used  uuid[] := '{}';
  v_a     uuid;
  v_d     uuid;
  v_equip text;
  v_n     integer := 0;
begin
  if v_demo is null then
    raise exception 'Demo samples are only added to a demo company, by its owner.' using errcode = '42501';
  end if;
  v_today := private.company_today(v_demo);
  -- The four reports: once per demo, and only when a fictional driver has a recent load (else a later Refresh).
  v_a := coalesce(private.demo_report_assignment(v_demo, v_today, v_today, v_used, false),
                  private.demo_report_assignment(v_demo, v_today - 2, v_today, v_used, false));
  if v_a is not null and not exists (select 1 from public.field_reports r
                                     where r.company_id = v_demo and r.snapshot ? 'sample' and r.reported_by is null
                                       and r.driver_id in (select d.id from public.drivers d where d.company_id = v_demo and d.user_id is null)) then
    -- 1. A breakdown on a truck, not resolved: today's load when there is one.
    perform private.demo_report_add(v_a, 'breakdown', 'truck',
      'Air pressure warning came on after loading. Pulled onto the shoulder with the hazards on; the truck is not safe to drive until someone checks the brake lines. (Sample report in a demo company.)',
      'open', '', auth.uid());
    v_used := v_used || v_a;
    v_n := v_n + 1;

    -- 2. A delay, acknowledged by the office with a note.
    v_a := coalesce(private.demo_report_assignment(v_demo, v_today, v_today, v_used, false),
                    private.demo_report_assignment(v_demo, v_today - 2, v_today, v_used, false));
    if v_a is not null then
      perform private.demo_report_add(v_a, 'delay', '',
        'About 40 minutes waiting to load: two trucks ahead and only one loader running. (Sample report in a demo company.)',
        'acknowledged', 'Customer told the load will be about 45 minutes late. (Sample.)', auth.uid());
      v_used := v_used || v_a;
      v_n := v_n + 1;
    end if;

    -- 3. An equipment problem, resolved: an earlier day, on the trailer when the load has one.
    v_a := coalesce(private.demo_report_assignment(v_demo, v_today - 2, v_today - 1, v_used, true),
                    private.demo_report_assignment(v_demo, v_today - 2, v_today, v_used, true));
    if v_a is not null then
      v_equip := case when (select trailer_id from public.dispatch_assignments where id = v_a) is not null then 'trailer' else 'truck' end;
      perform private.demo_report_add(v_a, 'equipment_issue', v_equip,
        format('Left rear marker light out on the %s. (Sample report in a demo company.)', v_equip),
        'resolved', 'Bulb replaced at the yard before the next load. (Sample.)', auth.uid());
      v_used := v_used || v_a;
      v_n := v_n + 1;
    end if;

    -- 4. Edge case: "can't finish the load" from an earlier day, still waiting for someone to look at it.
    v_a := coalesce(private.demo_report_assignment(v_demo, v_today - 2, v_today - 1, v_used, false),
                    private.demo_report_assignment(v_demo, v_today - 2, v_today, v_used, false));
    if v_a is not null then
      perform private.demo_report_add(v_a, 'cannot_complete', '',
        'Delivery gate locked and nobody answering the site contact''s phone. Brought the load back to the yard. (Sample report in a demo company.)',
        'open', '', auth.uid());
      v_n := v_n + 1;
    end if;
  end if;

  -- Each demo owner who drives relief and has never sent a report: one open equipment problem on their own load.
  for v_d in
    select d.id from public.drivers d
    where d.company_id = v_demo and d.active and d.user_id is not null and d.hauler_id is null
      and exists (select 1 from public.company_memberships m where m.company_id = v_demo and m.user_id = d.user_id and m.active)
      and not exists (select 1 from public.field_reports r where r.company_id = v_demo and r.driver_id = d.id)
    order by d.id
  loop
    select a.id into v_a
    from public.dispatch_assignments a
    join public.order_loads l on l.id = a.load_id and l.company_id = a.company_id
    where a.company_id = v_demo and a.driver_id = v_d and a.status = 'active' and a.truck_id is not null
      and l.status = 'planned' and l.load_date between v_today - 2 and v_today + 1
    order by (l.load_date > v_today), l.load_date desc, l.starts_at desc, a.id
    limit 1;
    if found then
      perform private.demo_report_add(v_a, 'equipment_issue', 'truck',
        'Driver''s side mirror is loose and keeps moving. Tightened it by hand; it needs a proper fix. (Sample report in a demo company.)',
        'open', '', auth.uid());
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end;
$$;
revoke all on function public.demo_field_report_samples() from public, anon;
grant execute on function public.demo_field_report_samples() to authenticated;
