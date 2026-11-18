-- Rollback of 20261120024600_stop_added_notice: drivers are no longer told in the app when a stop is added to their
-- load. The alert type dispatch.stop_added is kept (notices already raised refer to it); nothing raises it any more.
begin;
drop trigger if exists alerts_new_stops on public.order_stops;
drop function if exists private.alerts_from_new_stops();
commit;
