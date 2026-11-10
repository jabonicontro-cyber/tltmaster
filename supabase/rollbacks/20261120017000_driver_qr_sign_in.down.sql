-- Rollback of 20261120017000_driver_qr_sign_in.sql (not a migration; run by hand with a backup first).
-- Removes QR sign-in codes (open codes stop working at once) and the passkey audit helpers. Audit rows already written
-- (audit_events, security_events) are kept. Passkeys themselves live in Supabase Auth and are not touched.
begin;
drop function if exists public.my_passkey_added();
drop function if exists public.signin_passkeys_removed(uuid, integer);
drop function if exists public.signin_passkey_check(uuid);
drop function if exists public.signin_qr_failed(uuid);
drop function if exists public.signin_qr_redeem(text);
drop function if exists public.signin_qr_cancel(uuid);
drop function if exists public.signin_qr_status(uuid);
drop function if exists public.signin_qr_issue(uuid, text);
drop function if exists private.signin_qr_refusal(uuid, uuid);
drop table if exists private.signin_qr_codes;
commit;
