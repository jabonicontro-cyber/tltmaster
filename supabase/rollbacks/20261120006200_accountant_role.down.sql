-- Rollback for 20261120006200_accountant_role.sql. PostgreSQL cannot remove an enum value; the value stays, unused,
-- once 20261120006300 is rolled back (no membership or permission can use it then). Nothing to do.
select 1;
