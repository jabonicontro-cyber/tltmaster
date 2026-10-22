-- App roles lose table privileges they never needed (defense in depth; no data, policy or behaviour changes).
--
-- Supabase's default privileges grant ALL on new public tables to anon and authenticated. Most migrations revoke and
-- re-grant narrowly, but 35 tables and views still carried TRUNCATE, TRIGGER and REFERENCES for those roles (for
-- example dispatch_recommendation_rejections, dispatch_bases, base_members, the CRM, payroll, onboarding-kit and portal
-- tables), and anon (signed out) still held SELECT, INSERT, UPDATE and DELETE on 20 of them. TRUNCATE ignores row-level
-- security and every trigger and empties a table for every company. None of this was reachable through the app: its API
-- (PostgREST) cannot issue TRUNCATE, and no row-level policy applies to anon, so signed-out requests saw and changed
-- nothing. Signed-out features (public site, portal sign-in) call reviewed functions, whose EXECUTE grants are unchanged.
-- Applies to existing tables and to tables created later by the postgres role (migrations).
-- Rollback: supabase/rollbacks/20261120002200_revoke_table_admin_privileges.down.sql.

revoke truncate, trigger, references on all tables in schema public from anon, authenticated;
revoke all on all tables in schema public from anon;
alter default privileges for role postgres in schema public revoke truncate, trigger, references on tables from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on tables from anon;
