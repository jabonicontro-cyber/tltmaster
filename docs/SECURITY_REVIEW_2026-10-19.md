# Security review — customer portal, Testing Lab, global search, MFA, company deletion (2026-10-19)

Scope: commits `8238483..891f996` (Preview). Method: code review of every call path plus proofs against the **local**
database in rolled-back transactions. Nothing here was verified against a hosted database; the migrations involved
(`20261120000600`–`000900`) are not applied hosted yet.

Fixes: migration `20261120001100_security_hardening` (local only; rollback `supabase/rollbacks/20261120001100_security_hardening.down.sql`,
tested) plus app changes. Regression tests: `tests/db/security-hardening.test.ts`, `tests/db/help-center.test.ts`,
`tests/e2e/customer-portal.spec.ts` (email-verified sign-up).

## Findings

| # | Severity | Finding | Status |
| --- | --- | --- | --- |
| F1 | High | Accepting a portal invitation created a **confirmed** account for the invited email for whoever held the link (`admin.createUser({ email_confirm: true })`). A staff member of any company (including a prospect demo owner) could invite an arbitrary address, open the link and own a confirmed account for it; a real company adding that address later through People (`add_existing_member`) would attach its membership to the attacker's account. | **Fixed (local).** The app no longer creates accounts from the link: Supabase Auth's own invitation email goes to the address and opening it proves ownership (`requestPortalAccount`, `src/app/portal/actions.ts`); the person chooses a password and returns to the invitation (pending-invitation cookie, `src/server/portal-invite.ts`). The database refuses invitations from demo companies and while the portal is not open; the invitation preview reports `demo` and the app never emails for a demo. |
| F2 | Medium | Company "require two-step verification", and a person's own authenticator, were enforced only by the app; the database served a password-only (aal1) session normally. `set_company_mfa_policy(false)` worked at aal1. The app read "enrolled" from the browser's session copy. | **Fixed (local).** `private.current_company_id()` returns no company below aal2 when the person has a verified factor or the company requires MFA (every RLS policy and company function inherits it). `mfa_policy()` reports `enrolled` from `auth.mfa_factors`; the app uses it and fails closed when the policy cannot be read. Any policy change needs aal2. |
| F3 | Medium | `platform_help_overview()` checked platform admin but not the platform's aal2 requirement. | **Fixed (local):** goes through `private.require_platform_admin()`. All 48 other callable `platform_*` functions already did. |
| F4 | Low–medium | Confirming a customer's portal quote answer ignored which version they answered; after a revision it would accept a version the customer never saw. | **Fixed (local):** refused when the quote's current version differs. |
| F5 | Low | Duplicate checks for portal quote requests (and none for support requests) and the recovery-code attempt limit could be raced by simultaneous requests. | **Fixed (local):** per-account advisory lock + recheck trigger on both request tables; per-person lock in `mfa_recovery_redeem`. |
| F6 | Low | Testing Lab portal preview path checked platform admin but not aal2. | **Fixed (local).** |
| F7 | Low | `portal_public()` returned the full company card (welcome text, contact details, feature switches) to anonymous callers even with the public page off. | **Fixed (local):** only name, branding, time zone and the demo flag unless the public page is on. |
| F8 | Info | Users can write their own `mfa.*` events (self-reported by design); removing a factor directly through Supabase Auth bypasses the app's password re-entry and is not logged; tracking pages show materials, windows and site only (no driver, truck or notes); `*` acts as a wildcard in search (harmless). | Documented; no change. |

## Verified as correct (no change)

- Platform MFA on every admin page and server action (`requirePlatformAdmin` / `assertPlatformAdmin`) and in every
  platform database function; no API route reaches a platform function.
- Emergency switch `private.platform_settings.platform_mfa_enforced`: writable only by the database owner (`postgres`);
  `authenticated` and `service_role` refused; no function writes it.
- Recovery codes: generation needs aal2; single use; 5 failures / 15 min; another person's code is useless; redeeming
  removes only the caller's own factors. Removing an authenticator needs aal2, the password and no policy requiring MFA.
- Portal isolation: another customer's order/ticket in the same company is "not found"; no internal notes, scheduling
  notes, driver, truck or employee fields are returned. Invitations hashed, 7-day expiry, one-time, revocable, email must
  match on accept. No portal file downloads exist yet.
- Testing Lab: previews limited to demo companies in the database at start and on every use; never a real customer
  account; banner shown under the same condition; role previews only narrow permissions.
- Global search: each group's permission matches its detail page; RLS with `security_invoker` views; the PostgREST filter
  cannot be injected (`,` `)` stripped, value always wrapped in `%`); `src/server/data/search.ts` untouched.
- Company deletion: refused while the database switch is off, even for an aal2 platform admin on an archived practice
  company; classification never inferred from a name; the app also refuses unless the database reports the switch on.

## Needs hosted verification (owner)

1. Whether hosted Supabase Auth refuses enrolling a second factor from an aal1 session when one is verified (if not,
   a password alone could reach aal2). Check in the dashboard / with a test account after the MFA migration.
2. That every platform administrator has enrolled an authenticator before `20261120000900` is applied (someone with
   only the password could otherwise enroll one).
3. Whether `set local session_replication_role = replica` (used by `platform_company_delete`) is permitted for the
   function owner on hosted Supabase — only matters if permanent delete is ever switched on.
4. The Supabase Auth invitation email template on the hosted project must keep the `/auth/confirm?…&next=/update-password`
   link (repository `supabase/templates/invite.html`), which the portal sign-up now relies on.
