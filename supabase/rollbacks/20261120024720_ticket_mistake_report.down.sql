-- Rollback of 20261120024720_ticket_mistake_report (TM1). Run with psql -v ON_ERROR_STOP=1 -1 -f.
--   * The driver's ticket lists return to their earlier fields (no paper number, no "mistake reported").
--   * The report functions, the correction trigger and the table go, with the reports in it. Their photos stay in the
--     private bucket, unlinked (removed by hand if wanted). The tickets themselves are never touched.
begin;

do $$
declare
  r record;
  v_def text;
begin
  for r in select * from (values
      ('private.driver_assignments(uuid, uuid, date, date, uuid)'::regprocedure,
       $old$'quantity', t.quantity, 'unit_code', t.unit_code, 'paper_number', t.external_reference) order by t.ticket_number)$old$,
       $new$'quantity', t.quantity, 'unit_code', t.unit_code) order by t.ticket_number)$new$),
      ('public.driver_portal_home()'::regprocedure,
       $old$'review_reasons', to_jsonb(t.review_reasons), 'paper_number', t.external_reference,
                                          'mistake_reported', exists (select 1 from public.ticket_mistake_reports m
                                                                       where m.company_id = t.company_id and m.ticket_number = t.ticket_number
                                                                         and m.driver_id = v_d.id and m.status = 'open')) order by t.created_at desc)$old$,
       $new$'review_reasons', to_jsonb(t.review_reasons)) order by t.created_at desc)$new$)) as t(fn, old_text, new_text)
  loop
    v_def := pg_get_functiondef(r.fn);
    if position(r.old_text in v_def) > 0 then
      execute replace(v_def, r.old_text, r.new_text);
    end if;
  end loop;
end;
$$;

drop trigger if exists ticket_mistake_corrected on public.delivery_tickets;
drop function if exists private.ticket_mistake_corrected();
drop function if exists public.ticket_mistake_report(jsonb);
drop function if exists public.ticket_mistake_photo_begin(uuid, text, integer);
drop function if exists public.ticket_mistake_photo_path(uuid);
drop function if exists public.ticket_mistake_resolve(uuid, text);
drop function if exists public.demo_ticket_mistake_sample();
drop table if exists public.ticket_mistake_reports;

notify pgrst, 'reload schema';

commit;
