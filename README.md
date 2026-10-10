# Top Line Trucking Manager

Operations software for Top Line Trucking — customers, materials and pricing,
quotes with PDF and email, order management (from accepted quotes or entered directly,
scheduling and status tracking), a fleet registry (trucks, trailers, drivers and
their qualifications), a dispatch board, and (in later phases) delivery
tickets, route planning and QuickBooks export.

Built with Next.js (App Router, TypeScript), Tailwind CSS and Supabase
(PostgreSQL + Auth). Accounting stays in QuickBooks.

## What works today (Phase 1 + first part of Phase 2)

| Area | Status |
| --- | --- |
| Sign in, sign out, password reset, invitations, roles | ✅ |
| Dashboard (quote figures from real records) | ✅ — operations figures arrive with later modules |
| Customers, contacts, job sites, search, archive | ✅ |
| Materials, hauling/charges, units, price lists with rate history | ✅ |
| Quotes: editor, pricing, numbering, revisions, status, history | ✅ |
| Quote print preview and PDF | ✅ |
| Quote email | ✅ code complete — **preview mode until an email provider is configured** |
| Settings: company, numbering, users, permissions, sample data, audit log | ✅ |
| Company separation: several isolated companies in one database (Top Line is company #1) | ✅ — no self-serve sign-up or billing |
| Orders: convert accepted quotes (one order per quote), direct orders, status workflow, delivery dates and time windows, detail edits, history, search and filters | ✅ — loads, trucks and drivers arrive with dispatch |
| Fleet: trucks, trailers, drivers, licenses and medical cards, service status with history, dispatch-readiness check | ✅ — maintenance, documents and PTO later |
| Dispatch: day board, loads per order with times, assign / reassign / remove trucks, trailers and drivers, eligibility and no double-booking | ✅ — week view and notifications later |
| Route Planner, Tickets, Reports | Planned — pages say so; nothing fake |

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
node --env-file=.env.local scripts/create-owner.mjs you@example.com "Your Name"
npm run dev                  # http://localhost:3000
```

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` / `build` / `start` | Next.js |
| `npm run lint` · `npm run typecheck` | ESLint · TypeScript |
| `npm test` | Unit tests (money, quote calculation, status rules, PDF, email) |
| `npm run test:db` | Database tests: RLS, permissions, cross-company isolation, quote workflow, quote-to-order conversion, order management, fleet registry and eligibility rules, dispatch assignments and concurrent double-booking, numbering (needs a migrated DB) |
| `npm run test:e2e` | Browser tests against a running app + local backend |
| `npm run stack -- up\|db-reset\|env\|down` | Lightweight local backend without Docker |

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
