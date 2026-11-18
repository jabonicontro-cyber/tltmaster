# Legal review packet: what Taviron actually does (for the Terms of Service and Privacy Policy)

Prepared 2026-11-06 from the code at commit `9ced69e`; **refreshed 2026-11-14** against the code at `dab2073` (Production
runs `0c22b47`, the same code). What changed since 2026-11-06 is in §13; §1, §4.4, §5, §7, §8.4, §11 and §12 were updated
to match. Facts, not legal advice.

Purpose: master plan item LR5 (docs/TAVIRON_MASTER_PLAN.md §12, rows LR5 and LR6; §8 row W7) and docs/LAUNCH.md step 6.
The owner's lawyer uses this to write the final Terms of Service and Privacy Policy before outside customers in
January 2027. Every statement points to where it lives in the repository. Where something is undecided or missing it
says **Not decided** or **Not implemented** and is repeated in §11 (open questions).

How to read the status words:

| Word | Meaning |
| --- | --- |
| **On** | Runs today in the deployed product with no further owner step. |
| **Built, off** | Code exists; nothing happens until the owner sets an account, key or switch. |
| **Not verified** | The code supports it, but whether the owner configured it on the live site is not recorded in the repository. |
| **Not implemented** | No code exists. |

Two cautions about scope:
- Production runs `0c22b47`; every migration through `20261120020700` is applied to the hosted database (migration
  workflow run 43153292716, 2026-11-12, docs/SESSION_HANDOFF.md). Which environment variables are set in Vercel cannot
  be read from the code; §5 says what is recorded.
- The live address is `https://www.mytaviron.com` (`mytaviron.com` redirects to it; owner decision 2026-11-14).
- The website (`mytaviron.com`) is still behind the early-access gate: `PUBLIC_SITE` and `SITE_INDEXING` are not set
  (owner decision 2026-11-05, master plan §12 row UX18). The privacy and terms pages exist but are not yet public to the
  world.

---

## 1. The parties

| Party | Who they are | Where in the code |
| --- | --- | --- |
| **Taviron (platform operator)** | The business that runs the software. **Legal entity: not formed / not decided.** The owner plans to form an LLC in Indiana (docs/SESSION_HANDOFF.md 2026-11-05: "Form the LLC (INBiz), then send the exact name and address for the legal pages"); master plan §12 UX18 says "legal entity name to come". The site footer says "© <year> Taviron. All rights reserved." (`src/components/site/site-footer.tsx`). Domain: `mytaviron.com` (`src/lib/site/urls.ts`). | master plan §9 Q15, §12 LR5 |
| **Platform team** | Taviron staff (`private.platform_admins`) at two levels: **Admin** (everything, including plans, prices, subscriptions and the team) and **Support** (enters companies to help, nothing else in the console). Granted only by an Admin's invitation from the console (fresh password and authenticator code; the invitee must set up two-step verification) or the operator script `scripts/platform-admin.mjs` (owner decision 2026-11-06, SA1). | `20261024000100_platform_owner.sql`, `20261120008900_staff_support_access.sql`, `src/server/platform.ts` |
| **Customer companies (tenants)** | Trucking and aggregate hauling companies that subscribe. Each is a row in `public.companies`; every business record carries its `company_id`. The owner's own company (Top Line Trucking) is on a free beta arrangement (docs/LAUNCH.md step 6; master plan §10). | docs/ARCHITECTURE.md "Companies" |
| **Staff users of a tenant** | People with a membership in a company and one role: owner, office, dispatcher, mechanic, driver, accountant (time-limited). Logins are by email, or by username for people without email (`<username>@users.mytaviron.com`, never a mailbox). | `company_memberships`; docs/ACCOUNT_PROVISIONING.md; `20261120006200_accountant_role.sql` |
| **Drivers** | A tenant's drivers. A driver record may exist without a login; with a login they use the phone app ("My Day", `/driver`). | `public.drivers` (`20261013000100_fleet_registry.sql`); docs/COMPANION_APP.md |
| **Employees without logins** | People in a tenant's directory (`public.employees`) who never sign in. | `20261031000100_employees.sql` |
| **Hired haulers and their drivers** | Owner-operators and subcontracted haulers a tenant hires (an add-on, switched on per company). The hauler's driver can accept offered loads in the app. | `20261120003700_hired_trucks.sql`, `20261120005700_hauler_settlements.sql` |
| **The tenant's customers (customer-portal accounts)** | A tenant's own customers who sign in at `/portal/<company-slug>`. A portal account belongs to one company and one customer; it is **not** a company membership and opens no business table. | docs/CUSTOMER_PORTAL.md; `20261120000700_customer_portal.sql` |
| **Recipients of tracking links** | Anyone a tenant sends an expiring order tracking link to (`/track/<token>`), no account. | docs/CUSTOMER_PORTAL.md "Tracking links" |
| **Accountants** | An outside accountant a tenant owner invites, read-only, with an end date; payroll only if the owner includes it. | docs/SCHEMA.md "Accountant access" |
| **Website visitors and leads** | People who visit the marketing site or send the demo-request / contact form. | `src/app/api/leads/route.ts`, `src/lib/site/lead.ts` |
| **Outreach prospects** | Trucking companies the platform team finds in the public FMCSA Company Census and emails by hand from its own mailbox. | `20261120007500_outreach.sql`, `src/server/fmcsa.ts` |
| **Early-access users** | Devices admitted through the early-access gate (shared password or personal code). | docs/ARCHITECTURE.md "Early access gate" |
| **Demo companies** | Ordinary companies with `companies.is_demo = true` holding fictional data, used for sales demos. They never send anything (no email, QuickBooks, invitations). One prospect demo contains two real people's names (the prospect, as its owner login, and one friend named as a driver) and touches from the prospect's life, added at the owner's request. | docs/DEMO_TENANTS.md §1–§2 |

---

## 2. Data collected, by who it is about

All tenant data lives in one Supabase PostgreSQL database, separated by `company_id` and row-level security (§4).
Files live in private Supabase Storage buckets.

### 2.1 Tenant staff (all users)

| Data | Notes | Where |
| --- | --- | --- |
| Account: email (or internal username address), password (hashed by Supabase Auth), sign-in times | Supabase Auth also keeps its own logs (IP addresses, sign-in events) under Supabase's control. | Supabase Auth; `src/server/accounts.ts` |
| Profile: full name, display name, phone, profile photo | Photo resized to 256 px in the browser, stored as bytes in `private.profile_photos`, shown only to the person and people in their current company. | `20261030000100_profile_self_service.sql` |
| Two-step verification: authenticator factor, optional phone number (if SMS codes are turned on), recovery codes (SHA-256 hashes), MFA events | | `20261120000900_mfa.sql` |
| Employment record: job title, department, employment type, status, hire/end dates, work email and phone, **emergency contact name and phone**, notes | Readable with `employees.view`. | `public.employees` (`20261031000100_employees.sql`) |
| **Compensation**: pay type, rate, effective date, notes | Separate table; only `employees.compensation`. | `public.employee_compensation` |
| Time off: category (**vacation, sick, personal, bereavement, jury duty**, unpaid, other), reason text, decisions, balances, accruals | | `20261104000100_time_off.sql`, `20261112000100_pto_balances.sql`, `20261112000300_pto_accruals.sql` |
| Work schedules, shift offers and acceptances | | `20261114000300_work_schedules.sql`, `20261120004700_shift_offers.sql` |
| Messages, channels, announcements, alert acknowledgments, presence (Available / Busy / Away / Busy – Active Delivery), message attachments | Content kept 14 days (§6). | `20261105000100_communications.sql` … `20261108000100_comm_hardening.sql` |
| Measured work metrics: driver scorecard (loads, on time, own tickets, reports), "Speed" (time to plan, ticket review pace per minute) | Derived on read from records; no ranking stored. | `20261120003800_driver_scorecard.sql`; feature `speed-metrics` in `src/lib/site/features.ts` |
| Accessibility settings (text size, high contrast, reduce motion, readable font) | Saved with the account; a copy in browser storage. | `20261120007300_accessibility.sql`, `src/lib/accessibility.ts` |
| Help Center: "Did this help?" answers with notes, search terms, support requests to Taviron | Platform team reads support requests and totals. | `20261120000400_help_center.sql` |
| Audit trail of what each person changed | Append-only. | `public.audit_events` (`20261010000100_foundation.sql`) |
| AI usage ledger rows (company, user, capability, model, outcome, token counts, latency) | Never prompts or answers. | `20261110000100_ai_usage.sql` |

### 2.2 Drivers (in addition to 2.1)

| Data | Notes | Where |
| --- | --- | --- |
| Driver record: name, employee number, phone, hire date, notes, primary truck | | `public.drivers` |
| **CDL**: class, endorsements, issuing state, issue and expiry dates, verified by/when | **License numbers are deliberately not stored** (comment in the migration). | `public.driver_qualifications` (`20261013000100_fleet_registry.sql`) |
| **DOT medical card**: expiry date, verified by/when | Imported "as entered and unverified" from spreadsheets. | same; import in `20261120008300_import_sites_trailers_credentials.sql` |
| **Hours of service**: duty status, drive/shift/cycle minutes left, source (manual / provider feed / demo), entered by | Taviron does not calculate HOS rules; only fresh provider data counts as verified. Off unless the company chooses a source. | `public.driver_hours` (`20261120004900_telematics.sql`) |
| **Proof-of-delivery position**: one latitude/longitude/accuracy taken from the driver's phone right after a ticket is submitted | Browser permission is asked; the ticket works without it; only the driver who entered the ticket, within 15 minutes, once. Shown to staff and to that customer on the portal. Never continuous tracking. | `public.ticket_locations` (`20261120004000_proof_of_delivery.sql`); `src/components/driver/driver-ticket-form.tsx` |
| Delivery tickets and **ticket photos** (paper tickets may show names or signatures) | Never replaced or deleted. | `20261015000100_delivery_tickets.sql`, `20261019000100_ticket_photos.sql`, bucket `ticket-photos` |
| Arrived / Left taps at stops, wait times | | `20261120005200_wait_times.sql`, `20261120008000_stop_times_per_stop.sql` |
| Field reports (delay, breakdown, equipment), vehicle inspections (DVIR) with defect photos | | `20261018000100_driver_portal.sql`, `20261120006000_vehicle_inspections.sql`, `20261120006700_maintenance_photos.sql` |
| **Safety incidents**: kind (accident, **injury**, property damage, spill, near miss), severity, description, injury yes/no, witnesses and statements, photos, investigation findings | | `20261120004300_safety_incidents.sql`, bucket `safety-photos` |
| Fuel purchases (driver, odometer, vendor) and daily trip sheets (miles per state, for IFTA) | | `20261120005800_fuel_ifta.sql` |
| **Payroll**: pay rules, payroll periods, entries per verified ticket, adjustments, exports; **pay statements** (each driver sees only their own after approval) | Gross pay only; no taxes or withholding. Owner-only (`payroll.manage`). | `20261118000200_driver_payroll.sql`, `20261120005900_pay_statements.sql`; docs/PAYROLL.md |
| Data kept **on the driver's phone** (browser storage): today's loads, customer and site, truck, instructions, queued tickets and inspections | Not shown after 18 hours; removed at sign-out. | docs/COMPANION_APP.md §4; `src/lib/offline/store.ts` |

### 2.3 Trucks and location (fleet)

| Data | Notes | Where |
| --- | --- | --- |
| Trucks and trailers: unit, VIN, plate, make, model, documents (registration, insurance, inspection, permits) with dates | | `20261013000100_fleet_registry.sql`, `20261102000100_fleet_management.sql` |
| **Truck positions**: latitude, longitude, speed, heading, time, source (manual / feed / demo), entered by | From a provider feed (company-generated feed key, only its hash stored) or entered by dispatch, optionally using the dispatcher's own device location. No retention limit (§6). | `public.vehicle_positions` (`20261120004900_telematics.sql`); `src/app/api/telematics/ingest/route.ts`; `src/components/fleet/telematics.tsx` |
| Company locations (yards, quarries) and customer job-site positions | | `20261120002600_route_planner_core.sql`, `20261112000500_routing.sql` |

### 2.4 The tenant's customers and their people

| Data | Where |
| --- | --- |
| Customers: name, email, phone, billing address, payment terms, tax-exempt flag, notes | `public.customers` (`20261010000200_customers_catalog.sql`) |
| Customer contacts: name, email, phone, notes | `public.customer_contacts` |
| Job sites: address, directions (may include access instructions), positions, site notes and photos sent by customers | `public.customer_sites`; `20261120004100_site_info_from_customers.sql`, bucket `site-photos` |
| Quotes, orders, loads, tickets | migrations `…000300_quotes`, `…000600_orders` onward |
| **Invoices issued by the tenant through Taviron** and **payments recorded** (amount, date, method: check, ACH, card, cash, other; reference; note) | `20261120004800_invoicing.sql`, `20261120007000_invoice_multi_order.sql` |
| Credit limits and credit holds | `20261120005600_credit_holds.sql` |
| CRM: activities, opportunities, tasks | `20261119000100_customer_crm.sql` |
| Portal accounts (email or username, password via Supabase Auth), invitations (hashed, 7-day, one-time), quote answers, quote and booking requests, support cases with attachments (photos or PDFs, 10 MB each) | `20261120000700_customer_portal.sql`, `20261120005500_portal_booking.sql`, `20261120006800_support_center.sql`, bucket `support-files` |
| Email delivery records (recipient, status, provider reference) | `email_deliveries` (docs/ARCHITECTURE.md "Email honesty") |
| QuickBooks links: Taviron customer to QuickBooks customer, invoice sends | `20261120003500_quickbooks.sql` |

### 2.5 Website visitors, leads, outreach, early access

| Data | Notes | Where |
| --- | --- | --- |
| Lead form: kind (demo/contact), name, email, company, phone, number of trucks, number of dispatch bases, message, page it came from | Repeat submissions from the same email within 90 days merge into the open lead. Platform team tracks status, notes and emails sent. | `src/lib/site/lead.ts`; `private.leads`, `private.lead_events` (`20261024000100_platform_owner.sql`, `20261028000100_demo_lead_workflow.sql`) |
| Lead rate-limit fingerprint: HMAC of the visitor's IP address (keyed with the service-role key), never the address | Rows older than 2 days are deleted, each time a new form is submitted. | `private.lead_attempts`; `rateKey` in `src/server/early-access.ts` |
| Automated-submission check: hidden "website" field and time-to-fill | Bot submissions are dropped without being stored. | `looksAutomated` in `src/lib/site/lead.ts` |
| Outreach prospects: email (as given to FMCSA), company, contact name, phone, city, state, DOT number, power units, drivers; suppression list (never removed); events | Public registry data. Taviron's system sends nothing; staff send from their own mailbox. Every email carries an unsubscribe link and the postal address. | `20261120007500_outreach.sql`; `src/app/unsubscribe/` |
| Early-access: codes (SHA-256), per-device grants with a **keyed hash of the IP address**, attempt counters (keyed hashes of IP, email, user), audit | **No purge** of grants or attempts exists. | `20261020000100_company_onboarding.sql`, `20261023000100_site_access_gate.sql` |
| Analytics | **Not implemented.** No analytics or advertising scripts, packages or cookies (`package.json`; owner decision 2026-11-05 "no analytics for now", master plan UX18). | — |

### 2.6 Commercial and onboarding data held by the platform team

| Data | Where |
| --- | --- |
| Per customer company: plan version, terms (monthly / annual), offer type, agreed monthly amount, onboarding fee state, go-live date, cancellation balance | `private.company_lifecycle` (`20261118000300_platform_lifecycle.sql`) |
| Onboarding forms (questionnaire, dispatch worksheet, integrations, testing, go-live acceptance with typed-name sign-offs), versioned | `20261120001500_onboarding_kit.sql` (the app refuses fields named like passwords, keys, card numbers or SSNs) |
| Onboarding documents | bucket `onboarding-documents` |
| Import batches: the raw rows of spreadsheets staged into a company | `private.import_batches`, `private.import_rows` |
| Platform audit | `private.platform_audit` |

### 2.7 Data Taviron says it does not collect

- Driver's license numbers (`20261013000100_fleet_registry.sql`, comment above `driver_qualifications`).
- Card numbers or bank details of anyone: there is no payment code (§9). Payment records hold method and a free-text reference only.
- Social Security numbers, dates of birth, tax ids: no such columns in any migration; onboarding forms refuse them.

---

## 3. Cookies and browser storage

No analytics or advertising cookies. All cookies below are first-party.

| Name | Purpose | Lifetime | Where |
| --- | --- | --- | --- |
| Supabase auth cookies (`sb-…`) | Sign-in session | Supabase's default; **browser-session only** when "Stay signed in" is unticked (default is ticked) | `src/lib/shared-device.ts`, `src/proxy.ts`, `src/server/supabase/server.ts` |
| `tlt_shared` | Remembers that "Stay signed in" was unticked | Browser session | `src/app/(auth)/actions.ts`, `src/app/portal/actions.ts` |
| `__Host-taviron-access` | Early-access device grant (signed, HttpOnly, Secure) | Up to `EARLY_ACCESS_DAYS` (default 30, max 90); re-checked every 5 min | `src/server/site-access.ts`; docs/DEPLOYMENT.md §6 |
| `taviron-lead-sent` | Shows the thank-you after a no-JavaScript form post | 60 seconds | `src/app/api/leads/route.ts` |
| Portal pending invitation | Holds a portal invitation token during sign-up | 7 days | `src/server/portal-invite.ts` |
| `taviron-preview`, `taviron-presentation` | Demo role preview and presentation mode | 8 hours | `src/app/(app)/demo-actions.ts`, `src/app/admin/testing-lab/actions.ts` |
| `taviron-demo-welcome` | Demo welcome dialog seen | — | `src/app/(app)/demo-actions.ts` |
| `taviron-sidebar` | Sidebar pinned or collapsed | 1 year | `src/components/layout/desktop-sidebar.tsx` |
| `taviron-qbo-state` | QuickBooks connection anti-forgery state | 10 minutes | `src/app/api/accounting/qbo/connect/route.ts` |
| Browser storage (localStorage) | Theme, accessibility copy, remembered list views, help guide progress, Smart Dispatch panel state; on drivers' phones the offline day and queue | Until cleared / sign-out for the offline data | `src/lib/theme.ts`, `src/lib/accessibility.ts`, `src/lib/nav-memory.ts`, `src/lib/offline/store.ts` |

The draft privacy notice mentions only sign-in cookies and the early-access cookie (§8).

---

## 4. Who can see what

### 4.1 Tenant isolation

- Every business table has `company_id`; every row-level security policy is
  `company_id = private.current_company_id() and private.has_permission('…')` (docs/ARCHITECTURE.md "Companies").
- The current company is resolved in the database from the signed-in person's active membership, never from the request.
- Composite foreign keys stop records of one company pointing at another's; `company_id` can never change.
- All `SECURITY DEFINER` functions pin `search_path = ''` and are on a reviewed list enforced by `tests/db/tenancy.test.ts`.
- Files: private buckets; paths start with the company id and are chosen by the database; downloads use 60-second
  signed links (docs/ARCHITECTURE.md "Storage").
- Below two-step level, a person who has an authenticator (or whose company requires one) gets no company at all
  (docs/SECURITY_REVIEW_2026-10-19.md F2).

### 4.2 Roles inside a company

Roles: owner, office, dispatcher, mechanic, driver, accountant. Permissions are per company and editable by owners
(Settings → Permissions); owner permissions are fixed (docs/ARCHITECTURE.md "Security model").

| Data | Default access |
| --- | --- |
| Compensation | `employees.compensation` only (`20261031000100_employees.sql`) |
| Payroll, pay rules | Owner only (`payroll.manage`); each driver sees only their own approved statement |
| Staff email addresses | `users.manage` only (`user_directory()`) |
| Safety incidents | owner, office, dispatcher read; owner, office manage; a driver sees only their own reports' status |
| Drivers | No table access; portal functions return only their own assignments (docs/ARCHITECTURE.md) |
| Accountant | `accounting.view` and `billing.view` only, until an end date; payroll only if included; each visit recorded |
| Dispatch bases | An owner can limit a person to some bases; 23 tables filtered (docs/ARCHITECTURE.md "Dispatch base access"). Known residual: a refusal message can name another base's record if the person already knows its id. |

### 4.3 Customer-portal accounts

Only through `portal_*` functions; only their own customer's orders, confirmed tickets (no driver, truck or review
details), quotes sent to them, their requests, support cases, issued invoices and statement. Never internal notes,
pricing rules, other customers, staff or driver details (docs/CUSTOMER_PORTAL.md; `tests/db/customer-portal.test.ts`).
The portal must be granted by the platform team and switched on by the company.

### 4.4 Platform team (Taviron staff)

- `/admin` answers 404 to anyone not in `private.platform_admins`; every `platform_*` function re-checks and requires a
  two-step (aal2) session (`20261120000900_mfa.sql`, `20261120001100_security_hardening.sql`).
- What platform functions return: leads, outreach prospects, per-company **counts** (members, customers, trucks, drivers),
  plans and lifecycle, onboarding forms, help support requests, import batches (which contain the imported rows),
  platform audit. They do not return a company's orders, tickets or other business records
  (`platform_company_directory` in `20261120000500_company_classification.sql`).
- **Support visits (SA1, since 2026-11-06; §13):** a staff member can enter a customer company and then sees and does
  everything that company's owner can, money included, inside that company only. In a live company this needs the
  owner's grant (1, 3 or 7 days, ended at any time); companies still onboarding and demo companies need none (a visit
  without a grant lasts up to 8 hours). A visit is not a membership: changes to people, roles, permissions and
  sign-ins become requests an owner approves (SA2). Every visit, grant and change is in the company's own history as
  "Name (Taviron support)", and owners see a banner. Before 2026-11-06 the only way to write into a company was the
  audited import approval; that is no longer true.
- Testing Lab and role previews work **only in demo companies**, and previews only narrow permissions
  (`src/lib/platform/preview.ts`; docs/CUSTOMER_PORTAL.md §2).
- **Technical access outside the app:** whoever holds the Supabase project credentials (the owner) can read the whole
  database in the Supabase dashboard, and the encrypted backups (§6.4) contain everything. No in-app policy limits that.
  Not documented in any customer-facing text.

---

## 5. Sub-processors and outside services

Environment variable names are from docs/SETUP.md, docs/DEPLOYMENT.md, `.env.example` and `src/server/env.ts`.

| Service | What it receives | Status | Switch | Where |
| --- | --- | --- | --- | --- |
| **Supabase** | All database records, files, sign-in accounts | **On** (project "taviron-staging" serves Production; free plan until the owner upgrades, LAUNCH step 1). Region: "a US region" per DEPLOYMENT §1; **exact region not recorded**. | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | docs/DEPLOYMENT.md §1 |
| **Supabase Auth email** | Invitation, password-reset and confirmation emails (recipient address) | **On**, using Supabase's built-in sender until the owner sets custom SMTP through Resend (LAUNCH step 3, waiting on owner) | Supabase dashboard | docs/LAUNCH.md §3 |
| **Vercel** | Hosting of site and app; request logs; two daily scheduled jobs | **On** (Hobby plan; the owner approved moving to Pro, LAUNCH step 1). Function region not set in `vercel.json`. | `vercel.json` crons need `CRON_SECRET` | docs/DEPLOYMENT.md §2 |
| **Resend** | App emails: lead confirmations and team notifications, quotes, invoices (PDF), support reply notices, account setup links, owner daily summaries, subscription notices | Domain verified. **Built, off**: the owner chose to switch it on before 2026-12-01 (docs/LAUNCH.md step 8); until then `preview` (nothing sent). Demo companies never send. One reply-to address (`EMAIL_REPLY_TO`) is used for every company's emails (§13). | `EMAIL_PROVIDER`, `RESEND_API_KEY`, `EMAIL_FROM`, `EMAIL_REPLY_TO`, `LEAD_NOTIFY_EMAIL`, `EMAIL_TEST_RECIPIENT` | `src/server/email/provider.ts` |
| **National Weather Service** (api.weather.gov, US government) | Map positions of job sites and bases with planned loads; no names | **On** (no key), on Command Center and Dispatch pages; demos get sample data | none | `src/server/weather.ts` |
| **OpenAI** | Pseudonymized question and operational data (§10); ticket photos only if photo reading is switched on | **Built; gated.** The owner reported the AI variables are set in Vercel (docs/AI.md §16, 2026-10-25); every real company is blocked unless listed in `AI_COMPANY_ALLOWLIST`, demos unless `AI_IN_DEMOS=on`. LR2/LR6 say AI stays off for customers until January. Which companies are allowlisted: **Not verified**. | `AI_PROVIDER`, `OPENAI_API_KEY`, `AI_CAPABILITIES`, `AI_COMPANY_ALLOWLIST`, `AI_SEND_PHOTOS`, limits | `src/server/ai/`; docs/AI.md |
| **HERE** (routing, geocoding, map tiles) | Coordinates, the address being looked up, truck dimensions; tiles through Taviron's server proxy | **Built, off** unless both variables are set; **Not verified**. Off in demos unless `ROUTING_IN_DEMOS=on`. | `ROUTING_PROVIDER=here`, `HERE_API_KEY` | `src/server/routing/`, `src/app/api/map-tile/`; docs/ROUTING.md |
| **Intuit QuickBooks Online** | Customers and invoices of handed-off orders, per business; OAuth tokens stored encrypted (key derived from the client secret) | **Built, off** until keys are set; production approval is an LR6 step | `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET`, `QBO_ENVIRONMENT` | `20261120003500_quickbooks.sql`, `src/lib/accounting/qbo.ts`; DEPLOYMENT §2d |
| **Twilio** (through Supabase) | Phone numbers and one-time codes for SMS two-step verification | **Built, off.** Taviron itself sends no texts; no other SMS feature exists. | `MFA_SMS`, plus Supabase Phone MFA configuration | DEPLOYMENT §3d |
| **Sentry** | Server errors only (no browser script): error type, message and stack trace (up to 2,000 characters each) with emails, 7+ digit runs and values after "bearer/token/key/secret/password" replaced; the page path with record ids replaced and the query string dropped; route, method, environment and the release commit. No headers, cookies, user ids or IP addresses of visitors (the report comes from Vercel's server). Names, short phone formats and non-UUID path tokens (for example `/track/<token>`) are **not** removed. Sentry's data region: **not recorded**. | **On** since 2026-11-09 (owner set `SENTRY_DSN` for Production, docs/LAUNCH.md §4) | `SENTRY_DSN` | `src/lib/monitoring/sentry.ts`, `src/instrumentation.ts` |
| **UptimeRobot** | Calls `/api/health` every 5 minutes (returns only ok/down per part, no data) | **On** since 2026-11-09 (owner) | none | `src/app/api/health/route.ts` |
| **GitHub** | Source code; CI; **encrypted full database backups** (AES-256, owner's passphrase) kept 14 days as workflow artifacts | **On** when the owner's two secrets are set; the migration workflow is reported green (SESSION_HANDOFF 2026-11-05) | `SUPABASE_DB_URL`, `BACKUP_PASSPHRASE` (GitHub secrets) | `.github/workflows/db-migrate.yml`; DEPLOYMENT §2c |
| **GPS / ELD providers** | Positions and hours posted by the company's own provider to Taviron's feed endpoint | **Built, off** per company (source "none" by default). No built-in brand integration. | Per company feed key | `20261120004900_telematics.sql` |
| **FMCSA public data** (data.transportation.gov) | Search filters only (platform outreach) | Platform team only | none | `src/server/fmcsa.ts` |
| **Google Gmail / mail apps** | Outreach emails the team sends by hand ("Open in Gmail") | Team tool, not part of the product | none | `src/lib/platform/outreach.ts` |
| **Google Fonts** | Nothing at runtime: fonts are bundled at build time by `next/font` | Not a runtime service | — | `src/app/layout.tsx` |
| **Outbound links** | Google Maps (driver "Navigate", destination address), OpenStreetMap (map position of a ticket), FMCSA SAFER | Only when a person clicks | — | `src/lib/driver/navigate.ts`, `src/app/(app)/tickets/[id]/page.tsx`, portal ticket page |
| Push notifications, native app stores | — | **Not implemented** | — | docs/COMPANION_APP.md §3, §7 |

The draft privacy notice lists Vercel, Supabase, Resend, HERE and OpenAI only (§8).

---

## 6. Retention, deletion, export, backups

### 6.1 Retention that exists in code

| Data | Rule | Where |
| --- | --- | --- |
| Communications message content, revisions, attachments | **14 days** from creation for every conversation kind; a company legal hold overrides. Files are removed by the nightly job (needs `CRON_SECRET`). Audit rows never hold message text. | `20261108000100_comm_hardening.sql`; `src/app/api/cron/comm-housekeeping/route.ts` |
| Lead rate-limit fingerprints | Deleted after 2 days, when the next form is submitted | `lead_submit` in `20261028000100_demo_lead_workflow.sql` |
| Portal invitations | 7 days, one-time | docs/CUSTOMER_PORTAL.md |
| Tracking links | 3, 14 or 30 days, revocable | same |
| Temporary sign-in setups | 7 days (printed) / 24 hours (emailed link) | docs/ACCOUNT_PROVISIONING.md |
| Driver's offline day on the phone | Not shown after 18 hours; deleted at sign-out | docs/COMPANION_APP.md §4 |
| AI prompts and answers | Not stored by Taviron (OpenAI: up to 30 days, its terms) | docs/AI.md §10, §17 |

### 6.2 Retention that does not exist

**Not implemented / Not decided:** no retention period or purge for leads, outreach prospects (suppressions are kept
forever by design), early-access grants and attempt hashes, MFA and portal attempt counters, truck positions, driver
hours, proof-of-delivery positions, audit logs (`audit_events` and `private.platform_audit` are append-only), AI
usage rows, ticket photos (never deleted by design), or any business record after a customer leaves. The draft privacy
notice says locations and retention periods "will be listed here before general availability".

### 6.3 Deletion

| What | State | Where |
| --- | --- | --- |
| Business records | Archived or deactivated, not deleted (customers, contacts, sites, materials, price lists). Tickets are revisions; voids keep the row. | docs/ARCHITECTURE.md "No hard deletes" |
| A whole company | Archive and restore exist. **Permanent delete** works only for archived companies classified "practice / test", never for demos, and only after the database owner turns on `company_delete_enabled` by SQL (off on every database). No path deletes a real customer company. | `20261120000600_company_delete_switch.sql`; `platform_company_delete` |
| Imports | Company undo deactivates what a batch created; the platform team's revert removes untouched records | `20261120004600_company_import.sql` |
| A person's account | **Not implemented** as self-service. Memberships can be ended. Auth users are deleted only to clean up a failed sign-up. (Apple requires in-app account deletion if store apps are published, docs/COMPANION_APP.md §7a.) | `src/app/(auth)/signup/actions.ts` |
| Website lead deletion | On request through the contact form (manual; no tool) | privacy page |
| 90-day post-cancellation retention, then deletion or anonymization | Owner's confirmed policy in master plan §10; **Not implemented** | master plan §10 |

### 6.4 Export

- CSV downloads exist for: the customer list (`src/app/(app)/customers/export/route.ts`), a year's invoices and payments
  (`src/app/(app)/accountant/export/route.ts`), approved payroll periods (`src/app/(app)/payroll/periods/[id]/export/route.ts`),
  billing handoff batches (`src/app/(app)/billing/batches/[id]/csv/route.ts`), IFTA (`src/app/(app)/fleet/fuel/ifta.csv/route.ts`).
- A **full company export** (owner 2026-11-17, master plan §12 EX1): Settings → Download your data, for the company's
  **owner only** (not other roles, not a Taviron support visit), in a two-step verified session. A zip of CSV spreadsheets
  of the company's records (customers, contacts, job sites, materials, price lists, quotes, orders and lines, loads,
  assignments, tickets, invoices, payments and payments by ticket, trucks, trailers, drivers and qualifications, hired
  trucks, people and sign-ins, work orders, fuel, time off) plus ticket photos and order documents in zips of up to 200
  files. Each download is recorded in the company's audit log (who, when, which part; never contents). Migration
  `20261120024500_data_export.sql`; `src/server/data-export/`. Master plan §10 promises export at no charge on cancellation;
  the published FAQ ("we provide your records ... within 30 days of your request") stays true.

### 6.5 Backups

- GitHub Actions: an encrypted full `pg_dump` of the hosted database, **only when a release has pending migrations**
  (not on a schedule), kept 14 days (`.github/workflows/db-migrate.yml`, `retention-days: 14`).
- Supabase daily backups (7 days) only after the upgrade to Pro (docs/BACKUP_RESTORE.md; LAUNCH step 1, waiting on owner).
  The free plan has none.
- **Files in Storage (photos, attachments) are not in the database backups** (docs/DEPLOYMENT.md §5).
- No restore drill has passed yet: "Until the first drill passes, backups are assumed, not proven" (docs/LAUNCH.md).

---

## 7. Security measures actually implemented

| Measure | Detail | Where |
| --- | --- | --- |
| Row-level security on every table | `anon` has no table grants; quote and order tables have no client writes | docs/ARCHITECTURE.md "Security model" |
| Server-side permission checks | Every page and action, then again in the database | `src/server/auth.ts` |
| Reviewed elevated functions | `search_path = ''`, on a test-enforced list | `tests/db/tenancy.test.ts` |
| Two-step verification (TOTP) | Mandatory for platform staff and, since 2026-11-11, for **anyone who can see or change money** in a real company, whatever the company setting (SEC4; recovery codes required for them); a company can require it for everyone; 10 hashed one-time recovery codes; 5 failures / 15 min lock; SMS codes optional and off | `20261120000900_mfa.sql`, `20261120018000_money_two_step.sql`; docs/CUSTOMER_PORTAL.md §3 |
| Re-authentication | Platform "Go Live Now" needs a password sign-in in the last 5 minutes | `src/server/reauth.ts` |
| Early-access gate | In front of everything but the public site; codes stored as SHA-256; shared password as HMAC; 10 wrong codes per network address per 15 min; fails closed without its secret | docs/DEPLOYMENT.md §6 |
| Rate limits | Lead form 5 per 15 min and 20 per day per hashed address; AI per company and per person per minute/day/month; recovery codes; wrong passwords 8 per sign-in per 15 minutes (only a hash of the login stored, `src/server/signin-limit.ts`); QR sign-in codes 5 per driver per 10 minutes and invented codes 8 per network address per 15 minutes. Supabase Auth's own limits were set by the owner 2026-11-09 (docs/LAUNCH.md step 7). | as cited |
| Audit trails | `audit_events` append-only (row triggers on customers, catalog, prices, settings, users, permissions; explicit events elsewhere); platform audit | `20261010000100_foundation.sql` |
| Input validation | zod on the server, again in the database | docs/ARCHITECTURE.md |
| Upload checks | Size, magic bytes vs declared type, same origin; no public file URLs | docs/ARCHITECTURE.md "Storage" |
| Headers | HSTS (1 year), X-Frame-Options SAMEORIGIN, nosniff, strict referrer policy, Permissions-Policy (camera and microphone off, geolocation self) | `next.config.ts` |
| Secrets | Service-role key used only in `src/server/supabase/admin.ts`; QuickBooks tokens encrypted; feed keys stored as hashes | as cited |
| Security review | 2026-10-19: one high and two medium findings fixed (portal account takeover, MFA enforced in the database, platform help check) | docs/SECURITY_REVIEW_2026-10-19.md |
| Financial data | Every money permission has its own check on the server and in the database (one list, `private.money_permissions()` and `MONEY_PERMISSIONS` in `src/lib/permissions.ts`); fuel receipt dollars only with billing.view (SEC5); credit limits and detention rates only with billing.view; typed prices flagged until someone with pricing or billing rights confirms them (SEC4a) | master plan §12 SEC4, SEC4a, SEC5 |
| Not in place | No certifications or third-party audits; no penetration test; no published (customer-facing) incident or breach-notification procedure. An internal incident runbook exists since 2026-11-14 (docs/INCIDENTS.md). Open owner items: rotate `SITE_ACCESS_SECRET` (master plan §8 S2, unverified); hosted MFA checks (SECURITY_REVIEW "Needs hosted verification"); the first restore drill (docs/BACKUP_RESTORE.md). | docs/LAUNCH.md; master plan §8 |

---

## 8. Promises the website and app make today

### 8.1 Draft privacy notice (`src/app/(site)/privacy/page.tsx`, "Last updated November 5, 2026")

Every legal page carries the banner "Draft for early access, subject to change. This page has not yet been reviewed by
a lawyer … A signed agreement with your company takes precedence over it." (`src/components/site/legal.tsx`).

| Claim (quoted or close paraphrase) | Check against the code |
| --- | --- |
| Form data stored "so the Taviron team can reply and keep track of the conversation" | True. The form itself says "We use these details **only to reply** to you" (`src/components/site/lead-form.tsx`), narrower than the lead pipeline that exists (statuses, notes, conversion to onboarding). |
| "We do not sell this information or use it for advertising." | No code sells or advertises. A policy promise. |
| "a one-way, keyed fingerprint of the network address … for a short time" | True for the lead form (2 days, §6.1). Early-access grants keep a keyed IP hash with no time limit; not mentioned. |
| "This website sets no advertising or analytics cookies." | True. |
| App: records "used only to provide the service to that company"; sign-in and early-access cookies | Cookies list is incomplete (§3). Platform team sees aggregate counts and lifecycle data (§4.4). |
| AI: off unless a company turns it on; names, emails, phone numbers removed; record ids never sent; OpenAI does not train and keeps up to 30 days; Taviron keeps usage counts only; answers labelled and never change anything | Matches docs/AI.md for text. **Photo reading** (off, `AI_SEND_PHOTOS`) would send ticket photos that can show names and signatures; not mentioned. The OpenAI statements are OpenAI's terms (docs/AI.md §17), to be re-checked. |
| Providers: Vercel, Supabase, Resend ("such as sign-in links"), HERE ("never names"), OpenAI | Missing: National Weather Service (on), GitHub backups (on), Sentry, QuickBooks, Twilio (built, off). Sign-in links are sent today by Supabase's built-in sender, not Resend (LAUNCH step 3). |
| "locations and retention periods will be listed here before general availability" | Not decided (§6.2). |
| Correction or deletion of website data via the contact form | Manual only. No right-of-access/deletion process for app users is described. |

### 8.2 Draft terms (`src/app/(site)/terms/page.tsx`, "Terms of use", November 5, 2026)

Summary: early access, features may change, access by invitation and may be withdrawn; pricing "proposed and subject to
confirmation. It is not an offer"; nothing charged on the website; commercial terms only in a written agreement signed
by both parties; "Your company's records remain your company's"; the company is responsible for what its users enter
and for keeping sign-in details private; AI optional, can be wrong, labelled, never acts alone, OpenAI as
sub-processor; route planning distances are estimates and a route without warnings is not a guarantee; "Everything
shown in the demo company and in screenshots … is fictional. Any resemblance to real companies or people is
coincidental"; service provided "as it is" during early access, keep existing procedures.

Not present: limitation of liability, indemnity, governing law, disputes, acceptable use, data processing terms, SLA,
termination and data return, the named contracting entity. **No sign-up, portal or onboarding screen asks anyone to
accept the terms or privacy notice** (no clickwrap; searched `src/app/(auth)`, `src/app/portal`, `src/app/onboarding`).
The go-live acceptance is "recorded, not a digital signature" (`20261120001500_onboarding_kit.sql`); e-signing a service
agreement (master plan §10 onboarding) is **Not implemented**.

### 8.3 Trust & Security page (`src/app/(site)/trust/page.tsx`)

| Claim | Check |
| --- | --- |
| Row-level security per company; company id and role never trusted from the browser; demo companies never send | True (§4, docs/DEMO_TENANTS.md §2). |
| "Two-step verification … is built and being rolled out, starting with Taviron's own platform staff" | True: mandatory for platform admins; optional or company-required for others. |
| Key changes keep who and when; corrections are revisions; suggestions, plans and AI never act alone | True (docs/ARCHITECTURE.md). |
| "AI assistance is not switched on yet" | See §5 OpenAI row: configured per owner report, blocked for real companies unless allowlisted. Needs confirming. |
| "Database changes are tested on a copy first, applied in order with a backup taken beforehand" | True when the migration workflow's secrets are set (§6.5). |
| Not in place yet: no certifications; uptime and **support response times "agreed in the written service agreement"**; **self-service data export "ask us"**; provider list, locations and retention "before general availability" | The pricing page **does** publish support hours and a response target (§8.4). Several CSV exports exist (§6.4), so "no self-service export" understates the product; a full export does not exist. |

### 8.4 Pricing page and pricing FAQ (`src/app/(site)/pricing/page.tsx`, `src/lib/site/pricing-faq.ts`)

| Claim | Check |
| --- | --- |
| "Support: email, Monday to Friday, 9 a.m.–5 p.m. Central, excluding U.S. federal holidays, with a first response targeted within one business day." | Matches master plan §10 (confirmed policy). Conflicts with Trust page and FAQ ("support terms are set out in your service agreement"). No support inbox or ticketing for Taviron exists yet (LR4). |
| "The one-time onboarding fee is paid when you sign up. The monthly subscription starts at go-live." | Fee recording exists in the platform console; payment is by invoice (master plan §9 Q27). No billing code. |
| Annual commitment renews "unless you turn renewal off, and you are reminded before it renews" | **Built 2026-11-06 (SUB1, migration 20261120008800):** reminders 30, 7 and 1 day before the anniversary of the commitment start, emailed to the company's owners; renewal can be turned off per company by the platform team. Emails go out only once email sending is configured (otherwise recorded as not sent). |
| Over a tier: "30-day grace period, and we email you … moves to the lowest tier that fits from the next billing date. No plan change happens without notice." | **Built 2026-11-06 (SUB1):** daily count of active non-hired trucks and active bases; a 30-day grace with an email at the start and a week before the end; then the lowest fitting plan is proposed to the platform team, who schedules it (date and agreed price, emailed to the customer); it applies on that date. Not yet: excluding pickups and maintenance vehicles from the count (no vehicle flag), automatic downgrades, and the billing-date convention (§9 Q13). |
| Switching FAQ (WS1, owner 2026-11-09, on Production since `4912577`): "Standard plans are month to month: cancel any time with 30 days' notice and no cancellation fee. The onboarding fee is not refunded. An annual commitment runs its 12 months." | A policy promise; no code enforces or bills it (no billing code). Master plan §10 said "access to the end of the paid period"; the FAQ now says 30 days' notice. |
| Switching FAQ: "When you leave, we provide your records (customers, orders, loads, tickets with their photos, invoices, people and trucks) as spreadsheet files within 30 days of your request, and then delete your company's data." | **No full-export tool exists** (§6.4): it would be done by hand by the Taviron team. Deletion of a real customer company is not possible in the app (§6.3), and backups keep data for 14 days (GitHub) and 7 days (Supabase Pro) after deletion. Conflicts with master plan §10 ("data kept 90 days after access ends"). |
| Switching FAQ: "Plan for about 2 to 4 weeks from sign-up to go-live … You pick the go-live date, and the monthly subscription starts then." | Matches the pricing FAQ (subscription starts at go-live). |
| "There is no free trial." / "Nothing is charged through this website." | True. |
| "Prices are per company, in US dollars, before applicable taxes." | Tax treatment **Not decided** (master plan §9 Q15). |
| "Every tier includes the whole platform" | Hired trucks is an add-on switched on per company (`src/lib/site/features.ts`); its price is **Not decided**. |

### 8.5 FAQ and other pages (`src/lib/site/faq.ts`, `src/app/(site)/about/page.tsx`, `src/lib/site/compare.ts`)

- "Does Taviron send invoices or take payments? Invoices, yes; card or bank payments, no. … emails it as a PDF" (true
  when email is live) "… QuickBooks Online sync is coming soon" (built, off).
- "Does it track hours of service or GPS location? Yes, from your own provider or by hand … Taviron does not calculate
  hours-of-service rules."
- "Does Taviron use AI? AI assistance is built but not switched on yet … never assigns, sends, bills or changes records."
- About: "Each company's records are kept separate … people see only what their role allows, and changes are recorded."
- Comparison pages compare with "ways of working, never with a named competitor" (code comment in `compare.ts`).
- Only catalog features marked `published` may be described. Today: 44 published, 9 available but unpublished, 2 AI
  features in development and never described publicly (`src/lib/site/features.ts`). Some published limitation lines
  are out of date and **understate** the product: "order-to-cash" says invoices and payments are not built (invoicing is
  built and published); "people" says driver pay is not built; "inspections" says defect photos are not attached.

### 8.6 Safety and accuracy statements inside the app

- Driver app: "Use Taviron only when you are parked. Nothing here needs an answer while you drive." Stale data is
  labelled; "Got it" on a notice "is not proof the driver read or understood it" (docs/COMPANION_APP.md §3–§4).
- Smart Dispatch and Plan the day only propose; a dispatcher approves every assignment (CLAUDE.md; FAQ).
- Straight-line distances are labelled as estimates; geocoded positions are labelled estimates (docs/ROUTING.md).
- Hand-entered hours are shown, never treated as verified (`20261120004900_telematics.sql`).
- Demo companies show "fictional sample data … nothing is sent outside Taviron"; demo portals say "Nothing here is sent
  or charged" (docs/DEMO_TENANTS.md §2).

---

## 9. Commercial items

- **Published tiers** (gated pricing page; `src/lib/site/pricing.ts` is the only source): per company per month, before
  taxes.

  | Tier | Monthly | Trucks | Bases | Onboarding (one-time) |
  | --- | ---: | ---: | ---: | ---: |
  | Starter | $249 | up to 10 | 1 | $99 |
  | Essential | $499 | up to 25 | 1 | $199 |
  | Growth | $749 | up to 50 | up to 2 | $299 |
  | Professional | $999 | up to 75 | up to 3 | $399 |
  | Enterprise | from $1,499 | up to 100 | up to 5 | $599 |
  | Custom | quoted | more than 100 | several | from $599 |

  Annual commitment: 12 months paid monthly at 10% off. Extra training: $49 per session of up to 60 minutes.
- **How customers pay Taviron:** decided 2026-11-05: **by invoice** sent by Taviron, paid by bank transfer or check
  (master plan §9 Q27). **No payment, checkout, card or subscription billing code exists** (docs/PLATFORM_LIFECYCLE.md
  "Not built"; `20261118000300_platform_lifecycle.sql`: "No payment provider is connected"). The platform console only
  records plan, agreed amount, fee state and go-live.
- **Owner's confirmed policies, not implemented** (master plan §10): counting rules for trucks and bases; overage grace
  and tier moves; 60 days' notice of price increases; no refunds of unused periods; onboarding fee nonrefundable unless
  Taviron cannot deliver onboarding; annual auto-renewal with reminders 30, 7 and 1 day before; support hours;
  cancellation any time for monthly plans with access to the end of the paid period; data kept 90 days after access
  ends for export, then deleted or anonymized "under the final policy"; export at no charge. Master plan §10: "All
  customer-facing pricing, tax, refund and legal policies need legal review before launch."
- **Free beta:** Top Line Trucking (the owner's company) stays on its free beta arrangement (docs/LAUNCH.md step 6).
- Tenants use Taviron to bill **their** customers (invoices and recorded payments, §2.4); Taviron moves no money for them.

---

## 10. AI

| Rule | Where |
| --- | --- |
| Models are called only on the server through `src/server/ai/` (OpenAI adapter, Responses API, `store: false`) | docs/AI.md §1, §10 |
| Off by default: a key alone enables nothing; each capability needs its switch, model, token limits, the usage ledger and recorded passing evaluation evidence; real companies need `AI_COMPANY_ALLOWLIST`; demos need `AI_IN_DEMOS=on`; a platform pause switch stops everything | docs/AI.md §3–§4, §16; `src/lib/ai/evidence.ts` (evidence recorded for gpt-5-mini) |
| Capabilities: "Explain this plan", Ask Taviron (read-only operational questions), "Read a ticket photo" (also needs `AI_SEND_PHOTOS=on`) | docs/AI.md §7, §15, §18 |
| Pseudonyms: names, emails, phone numbers and record ids are replaced or removed; a check blocks the request if any remain | docs/AI.md §10 |
| Only reads what the person may see (their own session and permissions) | docs/AI.md §16 |
| Output is labelled AI-generated and checked; it never changes, assigns, sends or bills; a person decides | docs/AI.md §2, §8, §18 |
| Taviron stores usage counts only, never prompts or answers | docs/AI.md §6 |
| Disclosures the AI doc lists as needed before activation: privacy notice (done in draft), customer terms or DPA naming OpenAI and recording the company's opt-in (**Not done**), first-use in-app notice (a notice under the question box exists), OpenAI account settings (training off, spending limit, Zero Data Retention decision) | docs/AI.md §16–§17 |

---

## 11. Mismatches found (summary)

1. Privacy notice says Resend delivers sign-in links; today Supabase's built-in sender does (until LAUNCH step 3).
2. Privacy notice provider list omits the National Weather Service (on today) and GitHub (encrypted backups), and does
   not yet name Sentry, QuickBooks or Twilio (built, off).
3. Privacy notice lists two cookies; the app uses about ten cookies plus browser storage (§3), including customer and job
   details cached on drivers' phones.
4. Lead form says data is used "only to reply"; the lead is tracked as a sales pipeline.
5. Pricing page publishes support hours and a response target; the Trust page and FAQ say support terms are in the
   service agreement.
6. Pricing FAQ promises renewal reminders, overage emails and tier moves: built 2026-11-06 (SUB1), with a person scheduling each tier move; the count does not yet exclude pickups and maintenance vehicles.
7. Terms say demo content is entirely fictional and resemblance coincidental; one prospect demo uses real people's
   names by the owner's choice (docs/DEMO_TENANTS.md §1).
8. Trust page says there is no self-service export; several CSV exports exist (a full export does not).
9. Trust page and FAQ say AI is not switched on; docs/AI.md §16 records that the owner set the AI variables. Real
   companies are blocked unless allowlisted; needs confirming before the wording is kept.
10. The privacy notice's AI section does not cover ticket photos (off unless `AI_SEND_PHOTOS=on`).
11. Some published catalog limitations understate built features (§8.5).
12. The switching FAQ promises a full export "within 30 days" and then deletion; no export tool exists, a real company
    cannot be deleted in the app, and master plan §10 says 90 days (§8.4).
13. §4.4 of the first packet said platform functions never return a company's business records and writes happen only
    through imports; since SA1 a support visit sees and changes what the owner can (with the owner's grant in a live
    company). No customer-facing page says so yet; the Trust page and terms should.

---

## 12. Open questions for the owner and lawyer

**Entity and contracts**
1. Legal entity name, state, and postal address for the legal pages, the footer and outreach emails (LLC not yet formed).
2. Form of agreement: master subscription / service agreement, order form, DPA? Who signs, and how (e-signature is not built)?
3. Should sign-up, portal sign-up and onboarding require accepting the terms and privacy notice (no clickwrap exists)?
4. Who is controller and who is processor for tenant data (drivers, employees, the tenant's customers)? Taviron
   processes it on the tenant's instructions; the terms do not say so yet.
5. Governing law, disputes, limitation of liability, warranties after early access, indemnities.
6. Separate terms for customer-portal users and tracking-link recipients (the tenant's customers), and for hired
   haulers' drivers and accountants?

**Privacy and data**
7. Retention periods for: leads, outreach prospects, early-access and attempt hashes, truck positions, driver hours,
   proof-of-delivery positions, audit logs, AI usage rows, ticket photos, and all tenant data after cancellation (§6.2).
8. How the 90-day post-cancellation rule is carried out (deletion vs anonymization; backups and files included).
9. Process for access, correction and deletion requests from app users and from people in a tenant's records (drivers,
   the tenant's customers). Append-only audit logs and never-deleted ticket photos need a stated position.
10. Account deletion inside the app (needed for store apps, docs/COMPANION_APP.md §7a).
11. Data location: exact Supabase and Vercel regions; any transfers outside the US (OpenAI, Sentry).
12. Employee-data sensitivity: sick and bereavement leave, injury reports and witness statements, emergency contacts,
    compensation, accessibility settings, performance metrics. Do any state laws or tenant disclosures apply?
13. Location data: the proof-of-delivery position, truck GPS feeds, and the dispatcher device location. What notice must
    tenants give their drivers, and should Taviron's terms put that duty on the tenant?
14. Whether to keep the "OpenAI does not train / 30 days" statements in Taviron's own notice, and whether to apply for
    OpenAI Zero Data Retention.
15. Whether ticket photos may be sent to OpenAI (owner decision B84) and how that is disclosed.
16. Outreach: CAN-SPAM compliance of the template and suppression list; whether using FMCSA registry emails needs anything more.
17. Real people's names in the prospect demo: consent on record, and the terms' "fictional" statement.
18. Breach-notification and incident-response commitments to customers. An internal runbook exists (docs/INCIDENTS.md,
    2026-11-14); what customers are promised (who is told, how fast) is not decided.
19. Should sub-processor changes be notified to customers, and how?

**Commercial**
20. Final wording on pricing as an offer vs proposal; tax treatment and collection (master plan §9 Q15).
21. Invoice terms for paying Taviron (due dates, late payment, suspension for non-payment; master plan §10 says never
    delete data for non-payment).
22. Refunds, renewals, cancellation, price-increase notice: keep the master plan §10 policies, and which are published?
23. Support commitment: publish it (pricing page) or leave it to the agreement (Trust page)? Make the pages consistent.
24. Hired trucks add-on price and terms.
25. Responsibility for compliance outputs tenants rely on (IFTA figures, DVIR inspections, CDL and medical card
    expiry warnings, HOS shown from providers, route warnings, weather alerts): disclaimers needed beyond the current
    route-planning paragraph?
26. Taviron sends email on tenants' behalf (quotes, invoices, support notices, setup links): who is the sender of record
    and who is responsible for content and consent?

**Operational confirmations (owner, not legal)**
27. Which services are actually configured on Production. Recorded: `SENTRY_DSN` and `CRON_SECRET` set (2026-11-09 and
    before 2026-11-14), AI variables set but no real company in `AI_COMPANY_ALLOWLIST` (docs/AI.md §16),
    `ROUTING_IN_DEMOS=on`. Not recorded: `HERE_API_KEY`, `QBO_*`, `MFA_SMS`. `EMAIL_PROVIDER=resend` planned before
    2026-12-01. The January list is docs/SWITCH_ON.md.
28. Supabase and Vercel Pro upgrades (backups, commercial use), the first restore drill (procedure in
    docs/BACKUP_RESTORE.md), and rotation of `SITE_ACCESS_SECRET` (master plan §8 S2).

**New since 2026-11-06**
29. Support visits (§13): should the terms and the Trust page say that Taviron staff, with the owner's grant, can see
    and change everything an owner can (including money and pay records), and that companies still onboarding need no
    grant? Is the owner's grant in Settings enough consent, or does the agreement need to say it?
30. Support inbox notes and replies (§13): retention period for help requests and staff notes (none exists), and
    whether a reply recorded in the console but sent from a staff member's own email program changes who is the sender
    of record.
31. Face or fingerprint sign-in (passkeys, off): the face or fingerprint never leaves the phone and Taviron never
    receives it (Supabase stores only the passkey's public key). Does any biometric-privacy law (for example Illinois
    BIPA, near Top Line's Indiana base) still call for a notice before it is switched on?
32. QR sign-in: while a driver's code works (once, within 10 minutes), whoever scans it is signed in as that driver. Should the
    terms put the duty to show codes only to the right person on the company?
33. Exit terms (§8.4): align the published "30 days' notice", "export within 30 days, then delete" with master plan
    §10's 90 days, and with backups that keep data for 7 to 14 days after deletion. (Since 2026-11-17 the owner can also
    download all data themselves at any time, §6.4; the published promise was left unchanged.)
34. Payments by ticket (TP1): Taviron records payments a company received from its customers (amount, date, method,
    reference) and never moves money. Any wording needed so customers do not read it as payment processing?
35. One reply-to address for all companies' emails (`EMAIL_REPLY_TO`, §5): acceptable for Top Line's testing; before
    outside customers, should each company's emails carry its own reply address and name it as the sender of record
    (see also Q26)?

---

## 13. What changed since 2026-11-06 (refresh of 2026-11-14)

All of these are on Production (`0c22b47` or earlier) with their migrations applied, unless the row says otherwise.

| Change | What it does, and what data it involves | Where in the code | State |
| --- | --- | --- | --- |
| **Taviron support visits with owner grants (SA1)** | Two staff levels (Admin, Support). A staff member enters a live company only with its owner's grant (Settings → Taviron support: 1, 3 or 7 days; can be ended at once; ends by itself); onboarding and demo companies need none (visit up to 8 hours). Inside, staff act with the owner role: they see and change what the owner can, including money, payroll and voids; they are never listed as people or emailed. Visits and grants are recorded in the company's own history ("Name (Taviron support)") and the platform log; owners see a banner. Staff are invited from the console and must use two-step verification; a visit into a real company always needs it (SEC4). QuickBooks connect and sends are blocked during visits; prices typed during a visit are flagged; visits cannot confirm prices or show sign-in QR codes. | `20261120008900_staff_support_access.sql`, `20261120018100_quickbooks_support_visits.sql`; `src/server/platform.ts`; `src/app/staff/`; Settings → Taviron support | On |
| **Support change requests (SA2)** | During a visit, adding people, changing roles or permissions, creating, resetting, emailing or turning off sign-ins, inviting portal customers and accountant access become **requests**: the exact form is stored (never shown, read back only by the approving owner's own run), a plain summary is shown to the company's owners, who approve or decline; approval replays it as the owner with permissions checked again; one-time passwords or links go to the owner only; requests expire after 3 days; audited. No emails. | `20261120009200_support_change_requests.sql`; `src/server/support/` (`request.ts`, `execute.ts`) | On |
| **Support inbox and notes (PC1)** | Help requests customers send from the app's Help (name, sign-in email, company, page, message) are read by both staff levels, who set a status (New, Answered, Closed) and add internal notes or a reply. A reply is a record only: nothing is emailed from the console (the console offers to open it in the staff member's own email program). Every change is in the platform log; the sender sees the status in Help but not who handled it. Also: company health and usage **counts**, a customer timeline, console search, audit filters and a security overview (Admins); Support sees counts only for companies it could enter. No retention period for requests or notes. | `20261120020100`–`20261120020700` (notably `20261120020500_support_inbox.sql`); `src/app/admin/support/page.tsx`, `src/components/admin/support-inbox.tsx` | On |
| **QR sign-in for drivers (DS1)** | Someone who manages sign-ins shows a one-time QR code on the driver's page; the driver's phone scans it and is signed in on My Day. The code holds a random 256-bit token in the address fragment (never sent to a server log); the database stores only its SHA-256, the company, the driver record and the sign-in. Single use, 10 minutes; only for driver-only username sign-ins without money access; never in demos or during support visits; audited (issued, used, expired, refused, cancelled, failed) without the token. Invented codes are counted per hashed network address. | `20261120017000_driver_qr_sign_in.sql`, `20261120017100_signin_qr_money_rule.sql`; `src/server/signin-qr.ts`, `src/app/auth/qr/`, `src/lib/signin-qr.ts`; docs/ACCOUNT_PROVISIONING.md §7 | On |
| **Face or fingerprint sign-in (passkeys, DS1)** | Through Supabase Auth's passkey support: the face or fingerprint stays on the phone; Supabase stores the passkey (a public key). Offered only to active driver sign-ins without money access, never to Taviron staff or demos. Office can remove a lost phone's passkeys (audited). | `src/server/passkeys.ts`, `src/app/(auth)/passkey-actions.ts`, `src/lib/passkeys.ts` | **Built, off**: passkeys are not turned on in Supabase Auth; every passkey button is hidden (docs/SWITCH_ON.md item 7) |
| **Payments by ticket (TP1)** | The office records money a customer paid (customer, amount, date, method, reference, note) and applies it to specific delivery tickets; tickets show paid, part paid or open; unapplied money stays as the customer's credit; voids reopen tickets. A remittance CSV or pasted rows fill the form in the browser; the file itself is not stored. Taviron moves no money; QuickBooks companies keep QuickBooks as the record (sending payments there is not built). | `20261120009400_ticket_payments.sql`; `src/app/(app)/billing/payments/page.tsx`, `src/components/billing/ticket-payment-form.tsx`, `src/lib/billing/ticket-payments.ts` | On (catalog entry unpublished) |
| **Two-step verification required for money access (SEC4)** | Anyone who can see or change money in a real company (every billing and pricing permission, payroll, compensation, accounting, maintenance costs, audit; one list) must use an authenticator app and save recovery codes, whatever the company setting; below it the database gives them no company data. Demo-only accounts are exempt. Settings → Security shows who has set it up (yes/no only; SEC4b). | `20261120018000_money_two_step.sql`, `20261120019900_mfa_status_for_members.sql`; `src/lib/permissions.ts` (`MONEY_PERMISSIONS`) | On |
| **Fuel receipt dollars limited to billing (SEC5)** | Fuel receipt totals are readable only with billing.view (by default owner, office and the outside accountant); dispatchers, mechanics and drivers still see gallons, odometer, state and vendor, not amounts. | `20261120019800_fuel_dollars_money_only.sql` | On |
| **Other financial review fixes (SEC4a)** | Credit limits and detention rates only with billing.view; price-affecting customer fields need pricing or billing permissions; a typed price is flagged until confirmed by someone with pricing or billing rights, corrections audited with old and new price; the credit-hold reason is required and recorded when assigning. | `20261120016100`–`20261120016400` | On |
| **Exit terms on the site (WS1)** | Switching FAQ: month to month, cancel with 30 days' notice, no cancellation fee, onboarding fee not refunded, annual runs its 12 months; full data export as spreadsheet files within 30 days of the request, then the company's data is deleted; go-live in about 2 to 4 weeks. | `src/lib/site/pricing-faq.ts` (`SWITCHING_FAQ`) | On the gated site. The export and the deletion are manual (no tool; §8.4, §11 item 12) |
| **Sentry error reporting (LR4)** | See §5: server errors with personal details scrubbed (`scrub()` and the path rule in `buildEnvelope()`); names and short phone formats are not scrubbed. | `src/lib/monitoring/sentry.ts`, `src/instrumentation.ts` | **On** since 2026-11-09 |
| **Live address** | `https://www.mytaviron.com` for Top Line from 2026-12-01 (owner 2026-11-14). | docs/LAUNCH.md step 3 | Decided |

**Open questions added:** §12 Q29 to Q35.
