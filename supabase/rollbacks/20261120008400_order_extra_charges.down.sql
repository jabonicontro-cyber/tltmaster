-- Rollback of 20261120008400 (by hand, owner approval only). Charges already added stay as order lines.
drop function if exists public.order_add_charge(uuid, uuid, numeric, bigint, text);
