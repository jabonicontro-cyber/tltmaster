-- Rollback of 20261120024620_demo_repair_history: removes public.demo_repair_history(). Sample history jobs it already
-- moved back in time stay where they are (fictional demo data, still in order). The app skips the step when the
-- function is missing (src/server/demo/samples.ts rpcCount).
begin;
drop function if exists public.demo_repair_history();
commit;
