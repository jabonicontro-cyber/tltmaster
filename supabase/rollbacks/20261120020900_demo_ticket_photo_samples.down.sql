-- Rollback of 20261120020900_demo_ticket_photo_samples: Refresh demo data no longer adds sample ticket photos. Sample
-- photos already attached to demo tickets stay (they are ordinary attached photos of fictional demo tickets; the
-- stored files are kept).
begin;
drop function if exists public.demo_ticket_photo_attach(uuid);
drop function if exists public.demo_ticket_photo_begin(uuid, text, integer, text);
drop function if exists public.demo_ticket_photo_targets();
drop function if exists private.demo_ticket_photo_key(uuid);
commit;
