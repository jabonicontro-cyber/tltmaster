-- Rollback of 20261120015700_certificate_check_alert: certificates the shop recorded no longer raise an alert. Their
-- open alerts are resolved (the Fleet overview's list "Inspection certificates to check" still shows each one until it
-- is verified). The alert type documents.certificate_check is kept (alerts already raised refer to it); nothing raises
-- it any more.
begin;
drop trigger if exists vehicle_documents_certificate_check on public.vehicle_documents;
drop function if exists private.certificate_check_alert();
select private.comm_resolve_alert(a.company_id, a.event_type, a.source_key, 'Alert type withdrawn')
from public.alerts a where a.event_type = 'documents.certificate_check' and a.status = 'open';
drop function if exists private.raise_certificate_check(public.vehicle_documents);
commit;
