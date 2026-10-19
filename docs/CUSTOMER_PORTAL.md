# Customer portal, Testing Lab and two-step verification

Status (2026-10-19): implemented and tested **locally**; migrations `20261120000700`–`000900` are **not applied** to the
hosted database (owner step, `docs/runbooks/2026-10-14-hosted-db.md` §12–§13). Until they are, the new pages say a
database update is needed and nothing else changes.

## 1. Customer portal (B66)

A trucking company's own customers sign in at `/portal/<company-slug>`. It is not the Taviron website, not the company
workspace and not the platform console.

**Who can use it.** A portal account belongs to one company and one customer. It is **not** a company membership: it has
no role, no permission and opens no business table (RLS keeps refusing it). Customers read and write only through the
`portal_*` database functions, which take the company from the slug *among the signed-in person's own accounts* and the
customer from that account, and re-check every order, quote, ticket or request id against that customer.

**Turning it on (two separate decisions).**
1. Platform owner: Admin → Companies → the company → Customer Portal → *Grant Entitlement* (which plans include the
   portal is not decided, so nothing is granted automatically; removing it turns the portal off and keeps the records).
2. The company: Customer Portal → Settings → *Portal on*, plus which parts customers see (orders, tickets, quotes,
   support, help, tracking links) and an optional public page (welcome, contact details, published help only).

**What customers see.** Their orders with the planned schedule and loads (windows, not live ETAs), confirmed and
being-checked deliveries, a printable customer copy of each ticket (no driver, truck or review details), quotes that
were sent to them, their quote requests, support threads, and help. Never internal notes, scheduling notes, pricing
rules, other customers or staff/driver details.

**Quotes.** A customer's *accept* or *decline* is recorded as an answer; the office confirms it in Customer Portal →
Requests, which runs the normal quote status workflow (and therefore the existing quote→order rule). A customer never
changes a quote's status directly. Quote requests are de-duplicated (same material, quantity and date within 7 days).

**Access.** Staff create a one-time invitation link (Customer Access) and send it themselves; Taviron does not email it
(no provider). The link works once, expires after 7 days, and is stored only as a hash. One email belongs to one customer
per company. A new person sets a password; someone who already has a Taviron account signs in first.

**Tracking links.** From an order page (Customer Tracking), when the company turns tracking on: an expiring (3/14/30
days), revocable link showing only status, planned windows and confirmed quantities.

**Not built:** invoices and payments in the portal (Taviron has no issued invoices and no payment provider), emailed
invitations and notifications (no email provider), custom domains.

## 2. Testing Lab

Admin → Testing Lab. Everything happens inside a **demo company**:
- *Open in Demo* switches into the demo and sets a role view (Owner, Dispatcher, …), which only narrows your own
  permissions.
- *Preview as Customer* shows the demo's portal as one of its demo customers for one hour. The database allows this
  only for demo companies and platform admins, and records it in the platform audit. You are not signed in as anyone.
- *Record* stores what you checked (Tested, Failing, Needs configuration, Blocked). Nothing is marked tested
  automatically.
- Resetting data is Demo Management → Refresh demo data (additive, demo companies only).

## 3. Two-step verification (B69)

Supabase Auth TOTP (authenticator apps). Mandatory for platform administrators — the app and every `platform_*` database
function require a verified (aal2) session. A company may require it for everyone (Settings → Security). Anyone who set
up an authenticator is asked for it at every sign-in. Recovery codes (10, shown once, single use, replaced when
regenerated) remove a lost authenticator so a new one can be set up; a password reset never does. Five wrong codes in
15 minutes lock recovery for 15 minutes. Events are listed on My profile → Security.

**Owner, before applying `000900`:** confirm TOTP is enabled in Supabase (Authentication → Multi-Factor; on by
default) and set up your own authenticator on the deployed app (My profile → Security). Emergency switch for the
database owner only (SQL editor): `private.platform_settings` key `platform_mfa_enforced` = `'false'`.

## 4. Tests

`tests/db/customer-portal.test.ts` (isolation between customers and companies, invitations, duplicates, previews),
`tests/db/mfa.test.ts`, `tests/db/demo-samples.test.ts` (portal samples), `tests/e2e/customer-portal.spec.ts`,
`tests/e2e/testing-lab.spec.ts`, `tests/e2e/mfa.spec.ts`, `tests/unit/portal.test.ts`, `tests/unit/mfa-totp.test.ts`.
