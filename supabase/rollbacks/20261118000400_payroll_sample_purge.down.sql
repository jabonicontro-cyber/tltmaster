-- Rollback of 20261118000400_payroll_sample_purge (not a migration). Sample removal then fails again while a sample
-- ticket is in the payroll ledger; no data changes.
drop trigger if exists payroll_release_sample_ticket on public.delivery_tickets;
drop function if exists private.payroll_release_sample_ticket();
