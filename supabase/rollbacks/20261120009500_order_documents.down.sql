-- Rollback of 20261120009500_order_documents: order documents removed. The bucket and any stored files are left in
-- place (remove them by hand in Storage if wanted); the records go with the table.
begin;
drop function if exists public.order_document_remove(uuid, text);
drop function if exists public.order_document_path(uuid);
drop function if exists public.order_document_begin(uuid, uuid, text, text, integer, text);
drop table if exists public.order_documents;
commit;
