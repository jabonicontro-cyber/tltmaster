-- Rollback of 20261120015500_shop_decision_samples: removes the demo sample function. Sample records already added to
-- demo companies stay (fictional demo data; Refresh never adds them again while the function is missing).
drop function if exists public.demo_shop_decision_samples();
