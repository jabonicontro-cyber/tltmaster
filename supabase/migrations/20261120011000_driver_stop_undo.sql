-- Driver undo for Arrived / Left (owner 2026-11-09: a wrong tap in the cab is fixed by the driver, not a phone call).
--
-- public.load_stop_undo(load, stop, event) takes back the driver's own last Arrived or Left tap on a stop:
--   * only the driver of the load's active assignment (the office corrects times with load_stop_set, as before);
--   * only a tap that driver recorded (source 'driver', entered by them), on today's business date, at most 10 minutes
--     ago; Left is taken back before Arrived (the last event first), and a stop whose detention the office already
--     decided is not changed;
--   * the row is kept: Left clears departed_at, Arrived clears arrived_at, so a new tap records again (load_stop_mark
--     fills an empty time). Nothing is deleted;
--   * written to the company history (wait_time.undone) with the time that was taken back.
-- Reversible: supabase/rollbacks/20261120011000_driver_stop_undo.down.sql

create or replace function public.load_stop_undo(p_load uuid, p_stop text, p_event text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  r      record;
  v_row  public.load_stop_times%rowtype;
  v_at   timestamptz;
  v_tz   text;
begin
  if (p_stop not in ('pickup', 'site') and p_stop !~ '^stop:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
     or p_event not in ('arrive', 'depart') then
    raise exception 'Choose the stop and whether you arrived or left.' using errcode = '22023';
  end if;
  select * into r from private.stop_time_writer(p_load);
  if not r.own then
    raise exception 'Only the driver on this load can undo a tap. Correct the times on the wait-times report instead.' using errcode = '42501';
  end if;
  select * into v_row from public.load_stop_times where load_id = p_load and stop = p_stop and company_id = r.company_id for update;
  if not found then
    raise exception 'There is nothing to undo on this stop.' using errcode = 'P0002';
  end if;
  if v_row.source <> 'driver' or v_row.entered_by is distinct from auth.uid() then
    raise exception 'Only your own tap can be undone. Ask the office to correct the time.' using errcode = '42501';
  end if;
  if p_event = 'depart' then
    v_at := v_row.departed_at;
    if v_at is null then
      raise exception 'Left is not recorded on this stop.' using errcode = '22023';
    end if;
    if v_row.detention_status is not null then
      raise exception 'The office already decided detention for this stop. Ask the office to correct the time.' using errcode = '22023';
    end if;
  else
    v_at := v_row.arrived_at;
    if v_at is null then
      raise exception 'Arrived is not recorded on this stop.' using errcode = '22023';
    end if;
    if v_row.departed_at is not null then
      raise exception 'Undo Left first.' using errcode = '22023';
    end if;
  end if;
  v_tz := private.business_timezone(r.company_id);
  if v_at < now() - interval '10 minutes' or (v_at at time zone v_tz)::date <> private.business_today(r.company_id) then
    raise exception 'A tap can be undone for 10 minutes. Ask the office to correct the time.' using errcode = '22023';
  end if;

  if p_event = 'depart' then
    update public.load_stop_times set departed_at = null, entered_by = auth.uid(), updated_at = now() where id = v_row.id;
  else
    update public.load_stop_times set arrived_at = null, location_id = null, entered_by = auth.uid(), updated_at = now() where id = v_row.id;
  end if;
  perform private.log_event('wait_time.undone', 'order', r.order_id,
    format('%s %s undone by the driver', case when p_event = 'arrive' then 'Arrived' else 'Left' end,
           case when p_stop = 'pickup' then 'pickup' when p_stop = 'site' then 'job site' else 'stop' end),
    jsonb_build_object('load_id', p_load, 'stop', p_stop, 'event', p_event, 'recorded_at', v_at));
end;
$$;
revoke all on function public.load_stop_undo(uuid, text, text) from public, anon;
grant execute on function public.load_stop_undo(uuid, text, text) to authenticated;
