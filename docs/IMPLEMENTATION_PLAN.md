# Top Line Trucking Manager — Implementation Plan

## Architecture summary

One Next.js (App Router, TypeScript strict) application backed by Supabase
(PostgreSQL + Auth). No microservices.

```
Browser ──► Next.js server (React Server Components, Server Actions, Route Handlers)
              │   • zod validation of every input
              │   • permission check (server-side, from the database)
              │   • Supabase client bound to the signed-in user's session
              ▼
          Supabase PostgREST / Auth ──► PostgreSQL
              • Row Level Security on every table (second line of defense)
              • SECURITY DEFINER RPC functions for multi-table transactions
                (quote save / revise / issue / status changes, numbering)
              • Triggers: audit log, immutability of issued quote versions
```

Key decisions

| Topic | Decision |
| --- | --- |
| Rendering | Every operational page is dynamic and per-user. `cacheComponents` is **off** to keep the data model simple for maintainers. |
| Auth | Supabase Auth email + password, password reset by email. Session cookies via `@supabase/ssr`; `src/proxy.ts` refreshes sessions and redirects anonymous users. Public sign-up is not offered — the owner invites users. |
| Authorization | Roles → permissions are stored in `role_permissions` (editable by the owner). The same table is used by RLS policies, RPC functions, and the UI, so there is a single source of truth. |
| Money | Integer cents (`bigint`) everywhere. Quantities are `numeric(12,3)`; the TypeScript layer converts them to integer thousandths, so totals never use floating point. Quote totals are computed **in the database** (authoritative); the editor uses an identical TypeScript implementation for live preview, and a test asserts both agree. |
| Quote versions | `quotes` (header + number + status) → `quote_versions` (contact, job site, terms, totals, snapshots) → `quote_lines` (pricing snapshot per line). A version is locked when issued (sent/marked sent). Locked versions and their lines are immutable at the database level. Revising creates the next version. |
| Numbering | `document_sequences` table, row-locked `UPDATE … RETURNING` inside the transaction — safe for concurrent users. Format configurable (prefix, yearly reset, padding). |
| PDF | `@react-pdf/renderer` in a Node.js route handler. PDFs are rendered from the stored version data, so a sent version always re-renders the same document (the SHA-256 of what was emailed is recorded). |
| Email | Provider abstraction. `resend` (HTTP API) when `RESEND_API_KEY` is set; otherwise **preview mode** — nothing is sent and the quote is not marked sent. A test-recipient mode redirects every email to one inbox. |
| Maps / routing | Provider interface only in later phases; no fabricated routes or times. |
| Timezone | Stored as `timestamptz`; displayed in the configured business timezone (default `America/Chicago`, which covers Lake and Porter counties). |
| Sample data | Sample rows carry `is_sample = true`, are badged “SAMPLE” in the UI, and can be removed by the owner from Settings. |

## File structure

```
src/
  app/
    (auth)/login, forgot-password, update-password     sign-in & recovery
    auth/callback/route.ts                             email-link code exchange
    (app)/                                             authenticated shell
      dashboard/ customers/ quotes/ materials/ settings/
      orders/ dispatch/ routes/ tickets/ fleet/ reports/  (planned modules — explicit "not yet built" pages)
      quotes/[id]/versions/[versionId]/pdf/route.ts    PDF download
  components/ui/          reusable primitives (Button, Field, Table, Badge, Dialog, …)
  components/layout/      sidebar, mobile nav, page header
  lib/                    pure, testable business logic (money, quote calc, status rules, permissions)
  server/                 server-only: Supabase clients, auth/permission guards, data access, email, pdf
supabase/
  migrations/             committed SQL migrations
  seed.sql                fictional sample data
scripts/dev-stack/        lightweight local stack (Postgres + Supabase Auth + PostgREST) for CI/tests
tests/unit/               business-logic tests (vitest)
tests/db/                 database tests: RLS, permissions, RPC workflows (vitest + pg)
docs/                     architecture, schema, setup, backup/restore
```

## Environment variables / external accounts

| Variable | Needed for | Where it comes from |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | everything | Supabase project → Settings → API |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | everything (public, RLS-protected) | same |
| `SUPABASE_SERVICE_ROLE_KEY` | inviting users, bootstrap script (server only) | same — **never** expose to the browser |
| `APP_BASE_URL` | links in auth emails | your deployed URL |
| `EMAIL_PROVIDER` | `resend` or `preview` | — |
| `RESEND_API_KEY`, `EMAIL_FROM` | real email delivery | Resend account with a verified sending domain |
| `EMAIL_TEST_RECIPIENT` | optional: route all email to one test inbox | — |

External accounts required: Supabase project (free tier is fine for development),
an email provider (Resend recommended), a host for Next.js (Vercel or any Node host).
Later phases: a commercial-truck routing provider (evaluation pending) and QuickBooks
(Desktop vs Online to be confirmed).

## Assumptions that affect the data model

1. One company (single tenant). No multi-company support.
2. A quote belongs to one customer for its whole life; contact, job site, lines and
   terms can change between versions.
3. Money is USD, stored in cents. Unit rates are in whole cents.
4. Sales tax is a single configurable rate per quote (default from Settings, zero
   until configured), applied to lines marked taxable; customers can be tax-exempt.
5. Percent-based lines (fuel surcharge, percentage discount) are calculated on the
   sum of the quote's per-unit lines.
6. Prices are optional: when no catalog price exists, the user enters a rate. A rate
   that differs from a configured price is an “override” and needs the
   `pricing.override` permission (owner by default). Discounts need it too.
7. Quote expiration is set per version; overdue quotes are flagged and can be marked
   expired (no silent automatic status change).
8. Business timezone: America/Chicago.

## Checklist

Phase 1 — Foundation
- [x] Scaffold Next.js, Tailwind, strict TypeScript, lint, vitest
- [x] Migrations: roles/permissions, profiles, settings, numbering, audit log
- [x] Customers, contacts, job sites
- [x] Units, materials, charge items, price lists
- [x] Auth (sign in, sign out, password reset), proxy session refresh, noindex
- [x] App shell: sidebar, mobile nav, design-system components
- [x] Settings: company info, numbering, users & roles, email status, sample data removal

Phase 2 — Quotes (initial portion)
- [x] Quote editor with live, decimal-safe calculation
- [x] Database-authoritative totals, override permission enforcement
- [x] Sequential quote numbers
- [x] Versions: lock on issue, revise without overwriting, history
- [x] Print preview + PDF
- [x] Email provider abstraction with preview/test mode and delivery records
- [x] Status workflow: sent / accepted / declined / expired / canceled

Next (Phase 3) — Orders and tickets: convert accepted quote → order (idempotent),
direct orders, dispatch assignments, printable tickets.
