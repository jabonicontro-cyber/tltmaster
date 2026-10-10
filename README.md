# Taviron (working name)

Operations software for dump-truck and aggregate hauling companies — customers, materials and
pricing, quotes with PDF and email, order management, a fleet registry (trucks, trailers,
drivers and their qualifications), a dispatch board, delivery tickets, billing readiness with
handoff batches, a driver portal and one Command Center that coordinates them. Each company
has its own isolated workspace (users, data, numbering, pricing, permissions and settings);
the seeded "Top Line Trucking" sample company is development data only.

Built with Next.js (App Router, TypeScript), Tailwind CSS and Supabase (PostgreSQL + Auth +
Storage). Invoicing and payroll stay in each company's accounting system. The name is not
final; it is set in `src/lib/product.ts`.

## What works today (Phase 1 + first part of Phase 2)

| Area | Status |
| --- | --- |
| Sign in, sign out, password reset, invitations (new or existing accounts), roles | ✅ — emails tested locally with the dev mail catcher; hosted email needs setup (SETUP §2) |
| Early-access sign-up: access code → account → email verification → company with you as Owner; company switcher for people in several companies | ✅ — codes issued by operators (`scripts/early-access.mjs`); public sign-up stays off |
| Dashboard (quote figures from real records) | ✅ — operations figures arrive with later modules |
| Customers, contacts, job sites, search, archive | ✅ |
| Materials, hauling/charges, units, price lists with rate history | ✅ |
| Quotes: editor, pricing, numbering, revisions, status, history | ✅ |
| Quote print preview and PDF | ✅ |
| Quote email | ✅ code complete — **preview mode until an email provider is configured** |
| Settings: company, numbering, users, permissions, sample data, audit log | ✅ |
| Company separation: several isolated companies in one database (Top Line is company #1) | ✅ — self-serve only with an access code; no subscription billing |
| Orders: convert accepted quotes (one order per quote), direct orders, status workflow, delivery dates and time windows, detail edits, history, search and filters | ✅ — loads, trucks and drivers arrive with dispatch |
| Fleet: trucks, trailers, drivers, licenses and medical cards, service status with history, dispatch-readiness check | ✅ — maintenance, documents and PTO later |
| Dispatch: day board, loads per order with times, assign / reassign / remove trucks, trailers and drivers, eligibility and no double-booking | ✅ — week view and notifications later |
| Delivery tickets: enter actual quantities from paper/scale tickets, review, correct (revisions), void, history | ✅ — office entry; photos, signatures and printing later |
| Billing readiness: missing tickets, tickets to review, planned/ordered vs delivered (same unit only), acknowledged exceptions, handoff batches with a CSV file | ✅ — no invoices, payments or QuickBooks sync; the CSV is not a QuickBooks import format |
| Command Center (the home page; the old dashboard is merged into it): pinned attention summary, your work (assigned items, your own loads if you also drive), a prioritized queue (urgent orders, missing tickets, loads today without a truck, tickets to review, billing blocks, equipment out of service, assignment problems, driver reports) with links that return to the same view, operations figures, sales, activity; arrange and collapse sections, hide non-urgent items for yourself | ✅ — no notifications; no maintenance data yet |
| Urgent orders: office flags with a reason and needed-by time, dispatch acknowledges on the board, explicit states, optional escalation time, full history; never assigns trucks by itself | ✅ |
| Ticket review queue (position, accept and next) and an order progress panel (dispatch → tickets → billing readiness) | ✅ — driver pay / payroll not built yet |
| Driver portal (My Day): own assignments with site and instructions, ticket entry from the phone, delay / breakdown / inspection reports reviewed by the office; qualification reminders | ✅ — no offline queue |
| Paper scale-ticket photos from the phone (up to 3 per ticket), private storage, office viewing through one-minute links | ✅ — needs the storage bucket (see SETUP); storage files need their own backup |
| Route Planner, Reports | Planned — pages say so; nothing fake |

## Quick start (local)

Prerequisites: Node 22+, and either Docker (recommended) **or** a local PostgreSQL 15+.

```bash
npm install
cp .env.example .env.local
```

**Option A — Supabase CLI (Docker):**

```bash
npx supabase start          # prints the API URL, anon key and service_role key
npx supabase db reset       # applies supabase/migrations + supabase/seed.sql
```

Put the printed values into `.env.local` (`NEXT_PUBLIC_SUPABASE_URL`,
`NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`).

**Option B — no Docker** (plain PostgreSQL on port 54322 + downloaded Supabase Auth and PostgREST binaries):

```bash
npm run stack -- up
npm run stack -- db-reset
npm run stack -- env > .env.local    # local keys + URLs (overwrites .env.local)
```

Then create the first owner and start the app:

```bash
node --env-file=.env.local scripts/create-owner.mjs you@example.com "Your Name" top-line-trucking   # the seeded sample company
npm run dev                  # http://localhost:3000
```

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` / `build` / `start` | Next.js |
| `npm run lint` · `npm run typecheck` | ESLint · TypeScript |
| `npm test` | Unit tests (money, quote calculation, status rules, PDF, email) |
| `npm run test:db` | Database tests (incl. urgent orders, Command Center hiding/layout, company defaults and two-company isolation): RLS, permissions, cross-company isolation, quote workflow, quote-to-order conversion, order management, fleet registry and eligibility rules, dispatch assignments and concurrent double-booking, delivery tickets (numbering, revisions, duplicates), billing readiness (reconciliation, acknowledgments, handoff and concurrency), command center (classification, deduplication, visibility, paging, assignment), driver portal (identity, own assignments only, idempotent tickets, field reports), ticket photos and storage policies, early access and company onboarding (codes, rate limits, atomic company creation, existing members, owner-only Owner role), numbering (needs a migrated DB) |
| `npm run test:e2e` | Browser tests against a running app + local backend (incl. sign-up → onboarding → invitations, and allowed/refused pages per role) |
| `npm run stack -- up\|db-reset\|env\|down` | Lightweight local backend without Docker (with a local mail catcher) |
| `node --env-file=.env.local scripts/early-access.mjs create\|list\|revoke` | Early-access codes (operators) |
| `node --env-file=.env.local scripts/create-test-company.mjs "Name (test)" key` | A local test company with one account per role (see SETUP → Two independent test companies) |

## Documentation

- [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) — architecture summary, assumptions, phase checklist
- [docs/SETUP.md](docs/SETUP.md) — environment variables, Supabase, email, deployment, tests
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — how the code is organized and how security works
- [docs/SCHEMA.md](docs/SCHEMA.md) — database tables and rules
- [docs/BACKUP_RESTORE.md](docs/BACKUP_RESTORE.md) — backups and restoring them

## Sample data

`supabase/seed.sql` loads fictional customers, materials and placeholder
rates. They are flagged `is_sample`, shown with a **SAMPLE** badge, and can be
removed in **Settings → Sample data**. The placeholder rates are not company
prices.
