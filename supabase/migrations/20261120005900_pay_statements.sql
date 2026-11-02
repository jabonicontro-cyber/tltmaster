-- B131 driver pay statements (owner 2026-11-02: the office prints every driver's statement; each driver sees their own
-- on My Day once the period is approved, never anyone else's). Read-only functions over the existing payroll ledger:
-- calculated entries (each with its verified ticket) and adjustments. Nothing new is stored. Non-destructive.

create or replace function private.pay_statement(p_company uuid, p_period uuid, p_driver uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'period', jsonb_build_object('id', p.id, 'starts_on', p.starts_on, 'ends_on', p.ends_on, 'status', p.status, 'approved_at', p.approved_at),
    'driver', jsonb_build_object('id', d.id, 'name', d.name),
    'lines', coalesce((
      select jsonb_agg(jsonb_build_object('ticket', t.ticket_number, 'reference', t.external_reference,
               'delivered_on', (t.delivered_at at time zone coalesce((select cs.timezone from public.company_settings cs where cs.company_id = p_company), 'America/Chicago'))::date,
               'order_number', o.order_number, 'quantity', t.quantity, 'unit', t.unit_code, 'amount_cents', e.amount_cents)
             order by t.delivered_at, t.ticket_number)
      from public.payroll_entries e
      join public.delivery_tickets t on t.id = e.ticket_id
      left join public.orders o on o.id = t.order_id
      where e.company_id = p_company and e.period_id = p.id and e.driver_id = d.id and e.status = 'calculated'), '[]'::jsonb),
    'adjustments', coalesce((
      select jsonb_agg(jsonb_build_object('reason', a.reason, 'amount_cents', a.amount_cents) order by a.created_at)
      from public.payroll_adjustments a where a.company_id = p_company and a.period_id = p.id and a.driver_id = d.id), '[]'::jsonb),
    'earnings_cents', coalesce((select sum(e.amount_cents) from public.payroll_entries e where e.company_id = p_company and e.period_id = p.id and e.driver_id = d.id and e.status = 'calculated'), 0),
    'adjustments_cents', coalesce((select sum(a.amount_cents) from public.payroll_adjustments a where a.company_id = p_company and a.period_id = p.id and a.driver_id = d.id), 0))
  from public.payroll_periods p, public.drivers d
  where p.id = p_period and p.company_id = p_company and d.id = p_driver and d.company_id = p_company;
$$;
revoke all on function private.pay_statement(uuid, uuid, uuid) from public, anon, authenticated;

-- Payroll staff: any driver's statement for any period.
create or replace function public.payroll_statement(p_period uuid, p_driver uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v jsonb;
begin
  perform private.require_permission('payroll.manage');
  v := private.pay_statement(v_company, p_period, p_driver);
  if v is null then raise exception 'Statement not found.' using errcode = 'P0002'; end if;
  return v;
end;
$$;

-- A driver: their own statements of approved periods (approved, exported or reconciled), newest first.
create or replace function public.my_pay_statements()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('period_id', p.id, 'starts_on', p.starts_on, 'ends_on', p.ends_on,
           'total_cents', coalesce((select sum(e.amount_cents) from public.payroll_entries e where e.period_id = p.id and e.driver_id = private.my_driver_id() and e.status = 'calculated'), 0)
                        + coalesce((select sum(a.amount_cents) from public.payroll_adjustments a where a.period_id = p.id and a.driver_id = private.my_driver_id()), 0))
         order by p.starts_on desc), '[]'::jsonb)
  from public.payroll_periods p
  where p.company_id = private.current_company_id() and private.my_driver_id() is not null
    and p.status in ('approved', 'exported', 'reconciled')
    and (exists (select 1 from public.payroll_entries e where e.period_id = p.id and e.driver_id = private.my_driver_id() and e.status = 'calculated')
      or exists (select 1 from public.payroll_adjustments a where a.period_id = p.id and a.driver_id = private.my_driver_id()));
$$;

create or replace function public.my_pay_statement(p_period uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.current_company_id();
  v_driver uuid := private.my_driver_id();
begin
  if v_company is null or v_driver is null
     or not exists (select 1 from public.payroll_periods p where p.id = p_period and p.company_id = v_company and p.status in ('approved', 'exported', 'reconciled')) then
    raise exception 'Statement not found.' using errcode = 'P0002';
  end if;
  return private.pay_statement(v_company, p_period, v_driver);
end;
$$;

revoke all on function public.payroll_statement(uuid, uuid) from public, anon;
revoke all on function public.my_pay_statements() from public, anon;
revoke all on function public.my_pay_statement(uuid) from public, anon;
grant execute on function public.payroll_statement(uuid, uuid) to authenticated;
grant execute on function public.my_pay_statements() to authenticated;
grant execute on function public.my_pay_statement(uuid) to authenticated;
