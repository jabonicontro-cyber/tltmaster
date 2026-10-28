-- Rollback for 20261120004700_shift_offers.sql (B102). Removes shift offers, their answers and the company setting.
-- Shifts already written by filled offers stay on the Schedule (ordinary one-day shifts, reason "Shift offer").
-- Notifications already sent in the 'schedule' category are moved to 'membership' so the category check can be
-- restored (they stay readable).
begin;
drop function if exists public.demo_shift_offer_samples();
drop function if exists public.shift_offer_withdraw(uuid);
drop function if exists public.shift_offer_respond(uuid);
drop function if exists public.my_shift_offers();
drop function if exists public.shift_offer_cancel(uuid, text);
drop function if exists public.shift_offer_decide(uuid, boolean, text);
drop function if exists public.shift_offer_create(date, time, time, integer, text, text, uuid[]);
drop function if exists public.shift_offer_set_mode(text);
drop function if exists private.shift_offer_fill(uuid, uuid);
drop function if exists private.shift_offer_notify_person(uuid, uuid, text, uuid);
drop function if exists private.shift_offer_notify_planners(uuid, text, uuid);
drop function if exists private.my_employee();
drop function if exists private.shift_offer_problem(public.shift_offers, uuid);
drop function if exists private.shift_offer_label(public.shift_offers);
drop table if exists public.shift_offer_responses;
drop table if exists public.shift_offer_targets;
drop table if exists public.shift_offers;
drop table if exists public.shift_offer_settings;
update public.comm_notifications set category = 'membership' where category = 'schedule';
alter table public.comm_notifications drop constraint comm_notifications_category_check;
alter table public.comm_notifications add constraint comm_notifications_category_check
  check (category in ('direct', 'group', 'channel', 'announcement', 'alert', 'catch_up', 'membership', 'onboarding'));
commit;
