-- Remove sample data must not fail because a work order was opened from a sample driver report.
--
-- A driver on a sample load can report a real problem with a real truck (testing the app before go-live), and a
-- mechanic can open a work order from that report. Removing sample data deletes the sample order, which deletes its
-- driver reports (field_reports.order_id cascades), but work_orders.field_report_id had no delete rule, so the whole
-- removal failed with a database error. The work order is about a real truck and stays: only its link to the deleted
-- sample report is cleared (on delete set null of that one column; company_id stays). Nothing else changes.

alter table public.work_orders drop constraint work_orders_company_id_field_report_id_fkey;
alter table public.work_orders add constraint work_orders_company_id_field_report_id_fkey
  foreign key (company_id, field_report_id) references public.field_reports (company_id, id)
  on delete set null (field_report_id);
