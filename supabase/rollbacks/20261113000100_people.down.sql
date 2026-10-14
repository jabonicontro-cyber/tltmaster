-- Rollback note for 20261113000100_people.sql (a one-time data backfill; nothing to drop).
-- The employee records it created are ordinary records and are kept: removing them could break time off, pay or
-- driver links added since. To hide one, mark the person inactive on the People page. No statement is needed.
select 1;
