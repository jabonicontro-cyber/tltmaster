-- Rollback of 20261120024510_demo_duplicate_samples.sql (not a migration; run by hand after a backup). Removes the
-- duplicate finder; Refresh demo data then skips the cleanup step (it says the update is not installed). Rows already
-- removed by a Refresh are not restored (they were exact copies of rows that remain). No other rows change.
begin;

drop function if exists public.demo_duplicate_samples(text[], text[]);
drop function if exists private.demo_row_shape(jsonb);
drop function if exists private.demo_row_referenced(regclass, uuid, regclass);

commit;
