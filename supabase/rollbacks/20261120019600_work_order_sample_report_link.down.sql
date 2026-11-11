-- Rollback of 20261120019600_work_order_sample_report_link.sql (not a migration; run by hand after a backup). Restores
-- the work order's link to its driver report without a delete rule, so removing sample data fails again while a work
-- order points to a sample report. No rows change (links already cleared stay cleared).
begin;

alter table public.work_orders drop constraint work_orders_company_id_field_report_id_fkey;
alter table public.work_orders add constraint work_orders_company_id_field_report_id_fkey
  foreign key (company_id, field_report_id) references public.field_reports (company_id, id);

commit;
