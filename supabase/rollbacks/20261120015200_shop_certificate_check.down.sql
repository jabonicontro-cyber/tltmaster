-- Rollback of 20261120015200_shop_certificate_check: restores maintenance_record_inspection as in 20261120012400
-- (exact body) and removes the work_order_id reference on vehicle documents. Certificates and their verification stay.

create or replace function public.maintenance_record_inspection(p_wo uuid, p jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company  uuid := private.require_company();
  v_wo       public.work_orders%rowtype;
  v_on       date := nullif(p ->> 'inspected_on', '')::date;
  v_expires  date := nullif(p ->> 'expires_on', '')::date;
  v_who      text := left(trim(coalesce(p ->> 'inspector', '')), 120);
  v_ref      text := left(trim(coalesce(p ->> 'reference', '')), 80);
  v_today    date;
  v_doc      uuid;
  v_unit     text;
begin
  perform private.require_permission('maintenance.manage');
  select * into v_wo from public.work_orders where id = p_wo and company_id = v_company for update;
  if not found then
    raise exception 'Work order not found.' using errcode = 'P0002';
  end if;
  if v_wo.category <> 'inspection' then
    raise exception 'Only an inspection work order updates the inspection certificate.' using errcode = 'P0001';
  end if;
  if v_wo.status not in ('completed', 'closed') then
    raise exception 'Complete the inspection work order first.' using errcode = 'P0001';
  end if;
  v_today := private.business_today(v_company);
  if v_on is null or v_on > v_today or v_on < v_today - 365 then
    raise exception 'Enter the day of the inspection (not in the future).' using errcode = '22023';
  end if;
  if v_expires is null or v_expires <= v_on or v_expires > v_on + 731 then
    raise exception 'Enter when the inspection expires: after the inspection day, at most two years later.' using errcode = '22023';
  end if;
  if length(v_who) < 2 then
    raise exception 'Enter who did the inspection.' using errcode = '22023';
  end if;

  select id into v_doc from public.vehicle_documents where company_id = v_company and submission_key = p_wo;
  if v_doc is not null then
    update public.vehicle_documents set issued_on = v_on, expires_on = v_expires, issuing_authority = v_who,
      reference_number = v_ref, archived_at = null, archived_by = null, verified_at = null, verified_by = null,
      updated_by = auth.uid(), updated_at = now()
    where id = v_doc;
  else
    update public.vehicle_documents set archived_at = now(), archived_by = auth.uid(), updated_by = auth.uid(), updated_at = now()
    where company_id = v_company and kind = 'inspection' and archived_at is null
      and (truck_id = v_wo.truck_id or trailer_id = v_wo.trailer_id);
    insert into public.vehicle_documents (company_id, truck_id, trailer_id, kind, title, reference_number, issuing_authority,
      issued_on, expires_on, notes, submission_key, created_by)
    values (v_company, v_wo.truck_id, v_wo.trailer_id, 'inspection', 'Annual inspection', v_ref, v_who, v_on, v_expires,
      left('Recorded from work order ' || v_wo.number || '.', 2000), p_wo, auth.uid())
    returning id into v_doc;
  end if;
  select coalesce((select 'Truck ' || unit_number from public.trucks where id = v_wo.truck_id),
                  (select 'Trailer ' || unit_number from public.trailers where id = v_wo.trailer_id)) into v_unit;
  perform private.wo_event(v_company, p_wo, 'updated', null, null,
    format('Annual inspection recorded on %s: inspected %s by %s, expires %s.', v_unit, to_char(v_on, 'Mon FMDD, YYYY'), v_who,
      to_char(v_expires, 'Mon FMDD, YYYY')));
  return v_doc;
end;
$$;

drop index if exists public.vehicle_documents_unchecked_idx;
alter table public.vehicle_documents drop constraint if exists vehicle_documents_work_order_fk;
alter table public.vehicle_documents drop column if exists work_order_id;
