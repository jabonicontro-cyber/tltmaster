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

### 1a. Customer self-booking (B115, `20261120005500`)

Off by default (owner 2026-11-01); the company turns it on in Customer Portal → Booking (`settings.manage`), with the
earliest and latest bookable day. Dispatch (`dispatch.edit`) opens a number of loads per day (owner 2026-11-02);
customers see each day only as **open** or **full**, never the numbers or fleet details. `portal_booking_request` locks the
day's capacity row so pending + approved requests never exceed what was opened; a customer can withdraw a pending request.
Dispatch approves or declines (a reason the customer sees) with `booking_decide`, then creates the order as usual and links
it (same customer only). A request never schedules anything. Tables `booking_settings`, `booking_capacity`,
`booking_requests` (staff read with `dispatch.view`; customers only through `portal_booking_*`). Tests:
`tests/db/portal-booking.test.ts`, `tests/e2e/portal-booking.spec.ts`.

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

## Support center (B138, 2026-11-04)

Support requests became cases in the office's **Support** page (`/support`). Customers choose what a case is about,
can link one of their orders, tickets or invoices, attach photos or PDFs (5 per message, 10 MB each) and reopen a closed
case by writing within 14 days (after that they start a new one). Internal notes are staff only and never appear in the
portal or its functions. Each reply sends a short email notice with a link to the portal (no message content), to the
customer's active portal logins; demo companies never send, and a server without email set up only previews.

## Invoices, statement and Today (UX5, 2026-11-04)

When the company issues its invoices in Taviron (Settings → Invoicing) and the portal's Documents switch is on, the
portal shows **Invoices**: the customer's own issued invoices (never drafts or voided ones) with what was paid and the
balance, a printable invoice page, and a statement with the balance and aging (not yet due, 1–30, 31–60, 61–90, over
90 days past due) as of the company's today (`portal_invoices`, `portal_invoice`, migration 20261120006900). Read-only:
no online payment. The portal home also shows **Today** for orders scheduled today: loads planned for today and tickets
delivered so far, from recorded data only.

## Tickets and balance (WK2, 2026-11-09)

**Tickets** (portal menu, when the company's Documents switch is on): the customer's own delivery tickets across all their
orders, newest first and grouped by delivery day (the company's time zone), with job site, material, quantity and unit and
whether the office has confirmed them. Filters: a date range and one of the customer's saved job sites; **Download CSV**
gives exactly the filtered list (spreadsheet formulas are neutralised). At most 500 tickets per view; the page says when
there are more. Each ticket opens the existing printable customer copy (with its photos once confirmed). Data:
`portal_tickets` (migration `20261120014000`, tested rollback), the same rules as `portal_ticket`: company and customer
from the signed-in account, live tickets only, no driver, truck or review details. The CSV route
(`/portal/<slug>/tickets/csv`) calls the same function with the customer's session; signed out it answers 401, refused 403.
Before the migration the page says "Not available yet" and the CSV answers 404.

**Balance on the portal home:** when the portal shows Invoices, the home page shows the account balance (open invoices
total) and the overdue amount from the statement (`portal_invoices`), linking to Invoices.

Tests: `tests/db/portal-tickets.test.ts` (another customer of the same company, another company, staff, Documents off and
signed out see nothing), `tests/unit/portal-tickets.test.ts`, `tests/e2e/portal-tickets.spec.ts`, Testing Lab preview in
`tests/e2e/testing-lab.spec.ts`.

