-- Rollback of 20261120024630_demo_part_arrival_sample: removes public.demo_part_arrival_sample(). A sample job it already
-- added stays (fictional demo data; "Remove sample data" handles it like the other sample work orders). The app skips
-- the step when the function is missing (src/server/demo/samples.ts rpcCount).
begin;
drop function if exists public.demo_part_arrival_sample();
commit;
