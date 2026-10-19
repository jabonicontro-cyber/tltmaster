# Gap analysis — 2026-10-19

Reconciliation of the owner's "Gap analysis and continuation directive" against the repository (branch
`claude/ui-and-signin-checkpoint`, verified 2026-10-19). Status words: **verified** (implemented and covered by passing
tests in this session), **partial**, **not implemented**, **blocked** (needs an owner decision, credential or provider).
"Production" means the code is in a successful Production deployment record; hosted migrations are listed separately,
because until the owner applies them the feature shows its "needs a database update" state.

## 1. Platform owner console

| Requirement | Status | Evidence |
| --- | --- | --- |
| Launchpad: live counts, needs-attention queue, activity feed, quick actions | verified · Production `ce39234` · migration `20261118000100` not hosted | `src/app/admin/page.tsx`; `tests/db/platform-launchpad.test.ts` (5); `tests/e2e/platform.spec.ts` |
| Four fixed KPIs (customers, MRR, pipeline, onboarding) | verified · Production · migration `20261118000300` not hosted | `public.platform_console()`; MRR = agreed monthly amounts of live companies (onboarding fees excluded); `tests/db/platform-lifecycle.test.ts` |
| Acknowledge ≠ resolve; recurrence shows again | verified · Production | `private.platform_attention_acks`, `ackFor()` (`src/lib/platform/lifecycle.ts`) |
| Company directory and company page | verified · Production | `src/app/admin/companies/**` |
| Plans page (versioned catalog, §5.1 as v1) | verified · Production | `src/app/admin/plans/page.tsx`; DB test "new price is a new version" |
| Subscription per company, go-live earlier-only, Go Live Now with password, scheduled activation | verified · Production | `src/components/admin/subscription-card.tsx`, `src/server/reauth.ts`, `/api/cron/lifecycle-activation`; DB + e2e tests |
| Customizable dashboard (pin/reorder/hide non-critical sections) | not implemented (console) | The company Command Center has arrange/hide; the platform Launchpad does not yet |
| Company workspace tabs (Users, Integrations, Support…) | partial | Setup, people, imports, subscription, audit are on one page; no integrations or support tabs |
| Restricted support sessions (read-only, approved elevation, expiry) | not implemented · **owner decision** | Who approves the platform owner's own elevation? (B56) |
| System health with defined sources | partial | Demo refresh failures and failed lead emails are surfaced; no job/integration health store |

## 2. Administrator profile

| Requirement | Status | Evidence |
| --- | --- | --- |
| Own name + "Taviron Administrator" in console, companies and demos; initials fallback; never hardcoded | verified · Production `ce39234` | `src/server/data/profile.ts` (`PLATFORM_ROLE_TITLE`), `admin-user-menu.tsx`; e2e identity test. Shows the account's real profile name — the test account appears as "Pia Platform", your account as your profile name |
| Upload, replace, remove, type/size validation, secure storage | verified · Production | `photo-uploader.tsx`, `profile/actions.ts`; `tests/e2e/profile.spec.ts` |
| Preview before save, crop/reposition | **implemented this round** (commit `e96f6a5`, in Production `ce39234`) | Frame step with zoom and position; `framedCrop()` unit test; profile e2e saves only after "Save photo" |

## 3. Customer-facing CRM (company workspaces)

| Requirement | Status | Evidence |
| --- | --- | --- |
| Customers, multiple contacts, job sites, billing address, payment terms, notes | verified (existing) | `customers`, `customer_contacts`, `customer_sites` |
| Prospect vs customer without duplicates; account owner; tags | **implemented this round** (`6b8fab7`) · migration `20261119000100` not hosted | DB test "won turns the prospect into a customer (same record)"; first order also converts |
| Interaction history (calls, meetings, visits, notes, logged emails) | **implemented** | `customer_activities` (append-only); e2e |
| Tasks / follow-ups with assignee, due date, overdue | **implemented** | `customer_tasks`; pipeline "Due this week" |
| Opportunities: stages, value, probability, follow-up, lost reason, stage history | **implemented** (fixed stages) | `crm_opportunities`, `crm_opportunity_events` |
| Configurable stages | not implemented | Stages are fixed for now |
| Quotes, versions, accept → order; customer price lists | verified (existing) | `quotes`, `convert_quote_to_order`, `price_lists` |
| Links to orders and figures from real records | **implemented** | `customer_history()`: orders, ordered value (order totals, not invoices), accepted tickets, delivered quantities, quote win rate, 90-day quiet rule |
| Invoices / payments per customer | blocked by design | Invoices are issued outside Taviron (billing handoff); no payment records exist |
| Search, filter, sort; tag filter; CSV export; duplicate detection | **implemented** | list filters + sort, `/customers/export` (formula-safe), `customer_duplicates()` on create |
| Saved views; self-serve import; customer documents | not implemented | Import exists only through platform onboarding |
| AI summaries / follow-up suggestions | blocked | AI capabilities need the owner's key and passing evaluation evidence (docs/AI.md) |
| Separate from Taviron's own leads; company isolation | verified | DB test "another company sees nothing…"; platform leads stay in `private.leads` |

## 4. CRM integrated email

| Requirement | Status | Evidence |
| --- | --- | --- |
| Outbound email | partial (existing) | Resend adapter (`src/server/email/provider.ts`) sends quote emails with PDF; demos preview only |
| Settings → CRM → Email (modes A/B/C), per-company reply-to | not implemented | One global `EMAIL_REPLY_TO` today |
| Inbound replies, webhooks, threading, review queue, bounces | **blocked** | Needs: a provider account with inbound routing (e.g. Resend inbound or Postmark), a verified sending domain per company or a Taviron domain, and a webhook signing secret — owner setup and credentials |

## 5. Marketing Center (Taviron itself)

| Requirement | Status | Evidence |
| --- | --- | --- |
| Public site, feature catalog with publish gate, screenshots pipeline, pricing page, demo form → leads | verified (existing) | `src/app/(site)`, `src/lib/site/features.ts`, `scripts/capture-screenshots.mjs` |
| Analytics, attribution, campaigns, calendar, AI strategy execution, scheduling | not implemented · **blocked** for analytics/social/email | No analytics provider is connected (`SITE_INDEXING` is off); AI execution needs AI readiness evidence; social/email channels need accounts |

## 6. Billing and lifecycle

| Requirement | Status | Evidence |
| --- | --- | --- |
| Demo → fee (waivers) → onboarding → go-live (earlier only) → activation → subscription | verified · Production · migration not hosted | B53 |
| Published plans, founding 20%, Top Line free beta (one click on its page), contract preservation | verified | plan versions; agreed amount stored per company |
| Payment provider, invoices, failed-payment 72-hour read-only grace, restriction, restore on confirmed payment | **blocked** | Owner must choose a provider (e.g. Stripe), authorize billing code, and provide keys + webhook secret; the in-progress-delivery policy during restriction also needs a decision |

## 7. Open defect

`tests/e2e/command-center.spec.ts:59` failed once (2026-10-19 00:24 UTC, "Urgent" badge not found) and passed on an isolated
rerun; cause not found. Kept on watch.
