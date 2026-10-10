# Architecture

## Request flow

```
Browser
  │  (session cookie set by Supabase Auth via @supabase/ssr)
  ▼
src/proxy.ts ── refreshes the session; anonymous → /login
  ▼
Server Component page ──► requirePagePermission()  (src/server/auth.ts)
  │                         loads role + permissions via my_access() RPC
  ▼
src/server/data/*  ── Supabase client bound to the user's JWT ──► PostgREST ──► PostgreSQL
                                                                     RLS on every table

Client form ──► Server Action (src/app/(app)/*/actions.ts)
                 1. assertPermission()          (server, from the database)
                 2. zod validation               (src/lib/schemas)
                 3. table write (RLS) or RPC     (SECURITY DEFINER function that
                                                  re-checks permission, validates,
                                                  computes totals, writes audit log)
                 4. ActionResult {ok | error + fieldErrors} → form keeps the user's input
```

Every permission is enforced three times for writes: the page/action guard,
the database function or RLS policy, and (for quotes) table grants that allow
no direct writes at all.

## Code layout

| Path | Purpose |
| --- | --- |
| `src/lib/` | Pure, framework-free logic: money/quantity parsing, quote calculation, status rules, document model, zod schemas. Unit-tested. |
| `src/server/` | `server-only` code: env validation, Supabase clients, auth guards, data access, email provider, PDF rendering. |
| `src/components/ui/` | Design-system primitives (Button, Field, Table, Badge, Dialog, ConfirmDialog, Combobox, states, toasts). |
| `src/components/<module>/` | Module UI (customer panels, catalog tables, quote editor/actions/document, settings). |
| `src/app/(auth)/` | Sign-in, password reset. |
| `src/app/(app)/` | Authenticated app; layout renders the sidebar shell after `requireAccess()`. |
| `supabase/migrations/` | Schema, RLS, functions — the source of truth for business rules that must not be bypassed. |

## Key rules and where they live

| Rule | Enforced in |
| --- | --- |
| Quote totals | `public.save_quote_draft` (database). `src/lib/quotes/calc.ts` mirrors it for live preview; `tests/db/quote-calc-parity.test.ts` proves they agree on 40 random quotes. |
| Money never uses floating point | Cents as `bigint`; quantities `numeric(12,3)`; TS parses strings to integers and multiplies with `BigInt`, rounding half away from zero (same as PostgreSQL `round(numeric)`). |
| Sent quotes never change | `private.guard_locked_version` / `guard_locked_lines` triggers block updates and deletes of issued revisions, even by the database owner. |
| Revisions | `public.revise_quote` copies the issued revision into a new draft revision. |
| Price overrides & discounts need permission | `save_quote_draft` compares each rate with the configured price (customer list → standard list) and requires `pricing.override`. |
| Catalog price changes never alter quotes | Each quote line stores its own description, unit, rate, catalog rate at the time, and price source. |
| Sequential numbers, concurrency-safe | `private.next_document_number` row-locks `document_sequences`. Tested with two concurrent transactions. |
| Status transitions | `private.quote_transition_allowed` (DB) mirrored by `src/lib/quotes/status.ts`. |
| Email honesty | `sendQuoteEmail` marks a quote sent only after the provider accepts; all attempts recorded in `email_deliveries`. |
| Audit trail | Row triggers on customers, catalog, prices, settings, users, permissions; explicit events in quote functions. `audit_events` is append-only. |
| No hard deletes of business records | Customers, contacts, sites, materials, charges, price lists are archived/deactivated. Only mistaken rate entries can be deleted. |

## Security model

- **Roles**: owner, office, dispatcher, driver (future). A new account has no role and sees nothing until an owner assigns one.
- **Permissions** (`public.permissions`, `public.role_permissions`): editable by owners in Settings → Permissions; owner permissions are fixed so an owner cannot lock themselves out. At least one active owner must always exist.
- **RLS**: enabled on every table. `anon` has no grants. Quote tables are read-only to clients; all writes go through `SECURITY DEFINER` functions with `search_path = ''`.
- **Secrets**: the service-role key is only read in `src/server/supabase/admin.ts` (server-only) for invitations, after the caller's `users.manage` permission has been checked.
- **Indexing**: `X-Robots-Tag: noindex`, `robots.txt` disallow, and `robots` metadata.
- **Input**: all server actions validate with zod; database functions validate again.

## Rendering choices

`cacheComponents` is disabled: every page is private, per-user and must show
current data, so pages render on each request. Server Components fetch data;
Client Components are used only for interactive pieces (forms, dialogs,
the quote editor).

## Extension points for later phases

- **Orders**: will reference `quotes.accepted_version_id` and copy line snapshots; conversion must be idempotent (unique `orders.quote_id`).
- **Routing**: implement a `RoutingProvider` interface (geocode, matrix, route) with a "not configured" implementation; no fabricated results.
- **QuickBooks**: export approved billing records first; store external IDs and sync status per record to prevent duplicates.
