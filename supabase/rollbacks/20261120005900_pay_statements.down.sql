-- Rollback for 20261120005900_pay_statements.sql. Read-only functions; nothing stored is lost.
begin;
drop function if exists public.my_pay_statement(uuid);
drop function if exists public.my_pay_statements();
drop function if exists public.payroll_statement(uuid, uuid);
drop function if exists private.pay_statement(uuid, uuid, uuid);
commit;
