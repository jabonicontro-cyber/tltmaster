-- Rollback of 20261120020800_driver_proof_of_delivery: drivers can no longer add proof of delivery from My Day.
-- Documents drivers already added stay on their orders (as ordinary proof-of-delivery documents for their stop: the
-- office still opens and removes them); only the link to the load and the upload key go. Stored files are kept.
begin;
drop function if exists public.driver_stop_proofs();
drop function if exists public.driver_pod_begin(uuid, uuid, uuid, text, integer, text);
drop index if exists public.order_documents_load_idx;
drop index if exists public.order_documents_upload_key;
alter table public.order_documents drop constraint if exists order_documents_load_fk;
alter table public.order_documents drop column if exists upload_key;
alter table public.order_documents drop column if exists load_id;
commit;
