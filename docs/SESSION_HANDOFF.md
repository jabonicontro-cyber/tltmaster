# Session handoff — Taviron

Last updated: 2026-10-26 (redesign rounds, B91, B86, B84). Earlier: 2026-10-23 clean verification and base-level security audit; Phase B is 17 migrations. Contains **no secrets**: no codes, keys, passwords or
project credentials. Read it together with:
- `CLAUDE.md` and `docs/TAVIRON_MASTER_PLAN.md`: rules, decisions and open business questions.
- `docs/IMPLEMENTATION_PLAN.md`: §5m (N13), §5n (N14), §5o (N15: Smart Dispatch algorithm, hard blocks vs warnings, branding, fulfillment), "Recommended next task", and roadmap §8 A–H.
- `docs/RELEASE_CHECKLIST.md`: what to check before calling a release done.
- `docs/DEPLOYMENT.md`: hosting steps, including §2a (database updates) and §3a (platform access).

## 00000000000000000. 2026-10-27 (later) — seven owner ideas (B92–B98)

- **Built and tested locally:** quote win/loss (B95), driver scorecard (B96, `20261120003800`), truck health (B93,
  `20261120003900`), weather at job sites (B92, NWS, no migration), proof of delivery (B98, `20261120004000`), job-site
  notes and photos from customers (B94, `20261120004100`), end-of-day owner summary (B97, `20261120004200`). Every
  migration has a tested rollback and works with the code before it. Catalog entries added, unpublished.
- **Owner:** switch on the end-of-day summary per company (Settings → Email); it emails only when email delivery is
  live (Resend). Press **Refresh demo data** in each demo for the new samples (quote history, site note, proof positions).
  Publishing any of the seven on the website is your call.

## 0000000000000000. 2026-10-27 — website round (B88, owner "do it all")

- **Built and tested locally (production build):** comparison pages, paperwork calculator, public guides, What's new
  (three entries, owner-approved), link previews and canonical addresses, structured data,
  site-styled 404, scroll reveals, and the `next.config.ts` fix that had sent `noindex` on FAQ, Trust and every
  area/solution page. Every public page loads under 1 s locally with no sideways scroll at 390 px.
- **Pre-existing, not from this round:** `tests/e2e/platform.spec.ts` "live demo" fails locally on demo order data
  (same result without these changes); the marketing spec still expected the removed "Not yet" list (updated).
- **Owner:** approved the three What's new entries (2026-10-27, published). Still to decide: `SITE_INDEXING=on` on
  Production when the site should appear in Google.

## 000000000000000. 2026-10-26 — redesign rounds, B91, B86, B84 (owner at work; promotion authorized "as long as testing is good")

- **Production (each with Preview CI, Preview deploy, Production CI, migration workflow and Production deploy green):**
  `ffba4f7`, `ddc5048`, `f43cf47`, `bcc39ce`, `5ad99e0` (work order page redesign + B91). `cfed52b` (B86) and
  `fa73397` (B84) were pushed and handed to the same promotion script; see the final report in the chat for their
  outcome. Live site not reachable from the session: not verified in a browser.
- **Built this day:** Dispatch and Route Planner merged (order route panel, legs from the yard or the previous
  delivery); Schedule shows pending, approved and denied time off; pill centring rule everywhere (DESIGN_SYSTEM);
  Reports and Maintenance redesigns; work order detail redesign (WO #18282 reference); B91 time estimates that learn
  (`/maintenance/estimates`); B86 Speed section on Command Center (measured only); B84 AI ticket reading (off: needs
  `AI_SEND_PHOTOS=on` and evaluation evidence, docs/AI.md §18). B85 was already built (commit 1097838).
- **Owner decisions waiting:** may ticket photos go to OpenAI (B84); Twilio account and keys (B83); GPS provider (B87);
  website catalog lines for B84/B86/B91 (publishing is the owner's call); press **Refresh demo data** in each demo so
  the new samples (second deliveries, time off, maintenance board and history) appear.

## 00000000000000. 2026-10-23 — Production release `84707ae` (pushed, not verified live)

- Production branch fast-forwarded `5881927..84707ae` after all gates passed (owner authorization 2026-10-23). Full
  report: `docs/releases/2026-10-23-production-84707ae.md`.
- Not verified from here: Vercel deployment record (GitHub deployments API refused by the session permissions) and the
  live site (network policy blocks the Production hosts). Owner: check the deployment and run the smoke list in the
  report §I.1.
- Hosted database unchanged (through `000600`); Phase B (17) waits for admins' two-step enrolment in the live app, a
  backup and hosted credentials.

## 00000000000000. 2026-10-23 — Clean verification and base-level security audit before push

- **Bundle:** 14 commits on the Preview branch `claude/ui-and-signin-checkpoint` (`0024a00` … this entry), pushed
  together after the gates below. Production `5881927` unchanged; hosted database through `20261120000600`, nothing applied.
- **Security fixes (each reproduced before the fix, refused after):** base access on records attached to orders,
  loads and equipment (`001800`, `002000`; statement-level guard checks every old and new row, so bulk updates and
  deletes, multi-row inserts, upserts and MERGE cannot mix in another base), shop schedule (`002100`), Command Center
  counts (`002300`: a base-limited dispatcher saw 53 orders instead of 1), app roles' TRUNCATE/TRIGGER/REFERENCES and
  anon's table grants removed (`002200`). Next.js 16.4.2 (critical advisories). Model and matrix: ARCHITECTURE "Dispatch
  base access".
- **Hosted exposure until Phase B is applied:** on the hosted schema (Phase A) a person limited to some bases can read
  other bases' loads, assignments, tickets, work orders and history through the API (proven by the new browser test,
  which fails there at `order_loads`). Only companies that set Base Access are affected. Apply Phase B (17 migrations,
  runbook §14) after Production promotion and the MFA prerequisites.
- **Clean results (fresh PostgreSQL 16 cluster, every migration through `002300`, seed, storage; production build of
  the app code):** vitest **891/891** (135 files) at `be33674`; browser **206 passed / 1 failed / 10 skipped** — the
  failure was a race in the guided-onboarding test (it matched old history text), fixed in `a3422ef`, then 10/10 on
  repeat. Lint 0 errors (1 warning in an untracked scratch file), typecheck clean, `npm run build` passes.
- **Phase A (hosted-state) check:** full browser suite on a database with migrations through `000600` and the current
  build: 183 passed / 23 failed / 10 skipped; the 22 earlier failures (all Phase B features) plus the new base-access
  test above. No new compatibility failure.
- **Rollback/reapply (fresh cluster):** `002300`→`001800` rolled back leaves the 4 original policies, no guard and
  34 truncatable objects (5 of 6 base-scope tests fail); reapplied: 23 policies, 69 statement triggers, 0 row triggers,
  0 truncatable, 24/24 tests. `002000` alone rolled back restores `001800` exactly.
- **Found and fixed in the local stack:** `roles.sql` re-granted Supabase default privileges on every `stack.sh up`,
  undoing `002200`'s default-privilege revoke (CI would have failed the new tenancy test).
- **Owner actions:** promotion to Production (APPROVAL tier, `scripts/release/risk.mjs`); Phase B (17 migrations) after
  promotion, MFA enrolment and a backup; CRON_SECRET check (open `/api/cron/lifecycle-activation` signed out: 503 = not
  set, 401 = set); discount stacking decision (proposal: founding + annual suggest the single best discount); Next.js
  patch reaches Production only through promotion.
- **Residual risks:** refusal messages of elevated-rights functions (status changes, duplicate tickets) can name another base's record and its state if the caller already knows its id (found by the release gate run; nothing is written);
  local tests run on PostgreSQL 16, hosted is 17; 5 high npm advisories remain in lint tooling only.

## 00000000000000. 2026-10-22 — VER2 release verification, CI green, Command Center fixes, traceability

- **State:** Preview branch `claude/ui-and-signin-checkpoint` at `5837017` (pushed; Preview deployment record success at
  `https://tltmaster-eqxu04asd-taviron.vercel.app`, **not verified live** — the environment's network policy refuses
  `*.vercel.app`). Production `5881927`, unchanged (latest Production deployment record 2026-10-19). Hosted database
  through `20261120000600`; nothing applied from this session.
- **CI:** was red on every Preview push from `891f996` to `dc868d1` (database job: storage-dependent tests on a database
  without Supabase Storage, and a collation-dependent tag order). Fixed: the CI database job starts the storage server
  (cached build) and the stack sets up all three buckets; the tag test compares in code-point order. **Green on
  `5837017`.**
- **DB-test timeouts — root cause, fixed:** no index on `delivery_tickets.order_line_id`; the billing views read every
  live ticket per order line (Command Center 0.7–0.9 s per call for a ~900-order company). `20261120001600` adds the
  index: 250 ms, same results, 8 timeouts → 0 on the same data. Remaining: `billing_order_status` aggregates all
  companies before filtering (~170 ms) — follow-up.
- **Security fix:** Command Center items ignored per-person dispatch base access (a base-limited person saw other bases'
  order numbers, customer names, truck units, and could hide or assign them by key). `20261120001700` scopes the
  exception list at its source; test reproduced the leak, then passes. Apply soon after Production promotion.
- **Phase B is now 11 migrations** (`000700`–`001700`; runbook §14 updated). Prerequisites unchanged: Production on the
  two-step-screen code, platform admins enrolled (run the read-only MFA query), backup, then push.
- **Clean-state results** (fresh cluster, db-reset + seed + storage, app build of `e488ef2` = current app code):
  vitest 883/883; browser 204 passed / 2 failed / 10 skipped → the 2 were a test-order dependency (fixed `05b7a7c`,
  4/4). **Phase A compatibility** (database through `000600`, as hosted): 20 app pages render with no error page;
  Phase B pages show "needs a database update"; browser failures there are tests that expect Phase B migrations.
- **Traceability:** `docs/TRACEABILITY.md` (152 rows, evidence-checked) is the current status view; master plan §3 is
  marked historical; B14/B42/Q23 and two docs corrected.
- **Owner:** promote `5837017` to Production (approval); then Phase B (11); allow `*.vercel.app` in the environment's
  network settings if live Preview checks from a session are wanted; decide discount stacking (master plan §10 vs
  PLATFORM_LIFECYCLE); confirm `CRON_SECRET` on Vercel; AI provider and `npm run ai:eval` when wanted.
- **Next (no owner input needed):** base filter on the dispatch board and maintenance lists (B62); push the company
  filter into the billing views; not-found title; remove the unused `three` dependency; truck-count plan limits need a
  decision on enforcement (§5.1/§10) before building.

## 0000000000000. 2026-10-20 (late night) — post-Preview verification, website, Reports dates

- **Committed here:** the public website transformation (B78), typed MM/DD/YYYY dates on Reports (B79), and four
  browser-test fixes found by the full suite on a production build:
  - `FlashToast` now removes `?saved=` with the native history API (synced with the router) instead of
    `router.replace`. The router navigation re-rendered the page with new search params, which remounted it and
    cleared anything typed right after a save (the payroll period form, Go live now). This was a real input-loss
    defect, not only a test race.
  - The sidebar's hover-close now ignores touch/pen pointer-leave; the customer-portal "turn on sign-in" action no
    longer revalidates, which unmounted the one-time password panel (its Done button refreshes).
  - Tests: lifecycle and payroll wait for the save's own result (they matched text already on the page); two
    URL assertions accept the cleaned URL; the coordination DB test pages through the ticket queue.
- **Checks on the final tree (local, production build):** lint (0 errors), typecheck, unit 499/499, full browser
  suite 205 passed / 9 skipped / 2 failed → both fixed and re-run green (customer-crm, dispatch-bases, fleet: 7/7),
  the earlier four re-run green (29/29), gate spec 8 passed / 1 skipped, `check-deployment` all passed. The DB suite
  ran earlier in the session with the coordination fix; three of its tests are slow on this database's leftover e2e
  data (Command Center queue reads 0.7–1.3 s each), recorded, timeout not raised.
- **Not done:** Production promotion (owner), Phase B hosted migrations (owner, after authenticators), AI provider
  configuration (owner). Deployed Preview not verified live from this session (the site is unreachable from here).

## 000000000000. 2026-10-20 (night) — hosted Phase A complete (owner report)

- The owner's `supabase migration list` showed every migration through `20261120000500` already applied on the hosted
  database; the version check (anon cannot write help feedback, final grant on help searches, final delete preview)
  returned all true, so the hosted copies of `000400` and `000500` are the final ones. The owner then backed up, ran the
  dry run and pushed `20261120000600` from `8238483`, and reported the delete-switch verification and migration list as
  done. Reported by the owner; not independently verified from this session.
- **Hosted now:** through `20261120000600`. **Pending:** Phase B (`20261120000700`–`001500`, 9 migrations), which must
  wait until Production runs code with the two-step screens (runbook §14); then Refresh demo data.

## 00000000000. 2026-10-20 — username sign-ins, reference numbers, Onboarding Kit, Ask Taviron, order-to-cash chain test

- **Pushed to Preview** (`claude/ui-and-signin-checkpoint`) after the gates below; **not verified live** (the sandbox
  cannot reach the deployed domains). **Production unchanged** (`5881927`); promotion needs the owner, and this batch
  is approval tier (auth, migrations).
- **Built (code):** username sign-ins for employees and portal contacts with first-login setup (`20261120001200`,
  docs/ACCOUNT_PROVISIONING.md); readable references ORD-/QTE-/TKT-/BIL-/CUS-/MWO- for new records, legacy kept and
  searchable however typed (`20261120001300`, docs/REFERENCE_NUMBERS.md); sample removal with portal messages
  (`20261120001400`); Onboarding Kit with go-live acceptance that gates activation of companies with a checklist
  (`20261120001500`, docs/ONBOARDING.md §5); Ask Taviron, a read-only AI assistant (docs/AI.md §15) — Blocked until the
  owner configures a provider, a model and a passing evaluation; regression fixes from the full browser run.
- **Migrations:** `20261120001200`–`001500` applied to the **local** database only (backups in /var/lib/tlt-backups;
  none separate for the function-only `001400`). Hosted: nothing applied. Runbook Phase B now lists 9 migrations
  (docs/runbooks/2026-10-14-hosted-db.md).
- **Gates (local):** lint (0 errors), typecheck, production build, gate spec 8 passed / 1 skipped, deployment check.
  Vitest 855/857 — the 2 are 20 s timeouts in command-center and coordination from local data volume (18/18 with a
  longer timeout; committed timeout unchanged). New chain test `tests/db/order-to-cash-chain.test.ts` 3/3.
  Full browser run 185 passed / 9 skipped / 5 failed: four were stale test expectations (old `WO-`/`O-` formats, an
  inexact "No" locator now that presence is announced) and one ran during a dev-server restart; after the fixes all
  five specs and the new `ai-assistant` spec pass (21), and `quotes` passed 4 more times (one toast miss earlier).
- **Owner actions:** Phase B of the runbook when promoting (authenticator first); to turn on Ask Taviron: the AI usage
  migration, `AI_PROVIDER`, `OPENAI_API_KEY`, `AI_CAPABILITIES=ops_assistant`, `AI_MODEL_OPS_ASSISTANT`,
  `AI_MONTHLY_TOKEN_LIMIT`, then `npm run ai:eval` and commit the evidence only if it passed.
- **Not started:** multi-company financial attribution / intercompany accounting (needs decisions on legal entities,
  invoicing and accounting; no issued-invoice or payment model exists yet).

## 0000000000. 2026-10-19 — customer portal, Testing Lab, two-step verification, static homepage hero

- **Preview:** `73d7cbd` on `claude/ui-and-signin-checkpoint` (deploy 7183119850, success); earlier `8238483`
  (deploy 7181493096, success). **Production is still `5881927`:** the session's permission system refused the
  fast-forward of `8238483`, and the batch after it is **approval tier** (auth core: `src/proxy.ts`, `src/server/auth.ts`,
  `src/server/platform.ts`, `src/server/site-access.ts`; three migrations). Promoting is the owner's decision.
  Not verified live (the sandbox cannot reach the deployed domains).
- **Gates:** `8238483`: vitest 788/788, e2e 173 passed / 9 skipped, build, gate spec. Batch (`8480ddb`): vitest 806/806
  (121 files), e2e 176 passed / 9 skipped / 2 failed — both pass when re-run on port 3000 (sign-up email redirect allowed
  only for :3000 locally; a 60 s timeout on the slow resources page); later commits re-ran their specs (portal ×2,
  Testing Lab, MFA ×2, homepage, marketing, onboarding, dispatch availability), lint, typecheck, build, gate spec, and a
  hosted-state check with `000700`–`000900` rolled back (every page loads, database-dependent pages say so).
- **Built:** customer portal (B66, `20261120000700`), Testing Lab (`20261120000800`), two-step verification (B69,
  `20261120000900`), homepage hero with the real product (3D story retired), portal demo samples. Applied to the
  **local** database only (backups in /var/lib/tlt-backups). Hosted: nothing applied; runbook §12–§13 lists the expected
  pending set and the owner's steps — including setting up an authenticator **before** the push. Docs:
  `docs/CUSTOMER_PORTAL.md`.
- **Not done:** guided customer onboarding portal (B68), full website/design audit sweep, invoices/payments in the
  portal (no issued invoices, no provider), emailed invitations (no provider), custom portal domains.

## 000000000. 2026-10-20 (later) — Help Center and practice companies released `5881927`

- Preview 7167489920 and Production 7167511026 (success); not verified live. Hosted migrations now pending: `20261120000100`–`000500` (runbook §9–§10). Gates: vitest 787 + 1 timeout fixed (shared test DB growth, measured), e2e 171 passed + 2 intermittent passed on rerun, build, gate spec, pages checked without the migrations.

## 00000000. Round 2026-10-20 — multi-location, plan demos, visual alignment — released `4dc7383`

- **Released:** Preview deploy 7166311031 and Production deploy 7166330838 (both success, `4dc7383`). Not verified live
  (the sandbox cannot reach the deployed domains). Hosted migrations `20261120000100`–`000300` are **not** applied
  (owner, runbook §9); until then the new screens say a database update is needed — checked locally on a rolled-back
  database. `000400` (help center) and `000500` (company classification) are written but untested and not wired: do not
  apply them yet.
- Gates: lint, typecheck, vitest 776/776, full e2e 173/177 then the 4 failures fixed (test pollution from the bases
  test; a streaming race in the Command Center test) and their specs re-run green, build, gate spec.

- **Multi-location (B62):** migrations `20261120000100`–`000300` applied **locally only** (backups in /var/lib/tlt-backups);
  hosted application is the owner's `db push` (runbook §9). Settings → Dispatch Bases; base on forms and order page;
  list filters; per-person access (RLS); Smart Dispatch base rule; Reports → By Dispatch Base.
- **Regression found and fixed before commit:** the first base-access policy shape made `billing_order_status` take
  more than 60 s (planner estimates); the tenancy suite timed out. Fixed with a `base_unrestricted()` short-circuit (0.4 s).
- **Plan demos (B63):** Demo Management → Plan Shown.
- **Visual alignment (B64):** shared lockup, containers, terminology, Powered by Taviron link, phone overflow fix.
- Still requested and not started: Help Center (B65), customer portal + Testing Lab (B66), archive/delete practice
  companies (B67), guided onboarding (B68), MFA, website hero, CRM email, Marketing Center.

## 0000000. Round 2026-10-18 — Taviron Live, platform console, payroll, customer lifecycle

| Commit | What | Migration (local / pushed / hosted) |
| --- | --- | --- |
| `50d6450` | **Taviron Live round 1**: 7-day outlook on the Command Center (loads, coverage gaps, trucks down, people off, value at risk with billing.view, next steps). Benchmark: owner Command Center 374 → 404 KB, ~1.7 s local; dispatch payload unchanged (2.2 MB). | none |
| `188a81d` | **Platform Launchpad (B52)**: live counts, one needs-attention list, activity feed, company directory and detail, audited demo refreshes, duplicate-company refusal | `20261118000100` local / not pushed / **not hosted** |
| `dc5900f` | **Administrator identity**: the platform admin appears as their own profile (name, photo or initials, "Taviron Administrator") in the console, company workspaces and demos; profile page in the console | none (touches `src/server/auth.ts` → APPROVAL tier) |
| `ca35b20` | **Driver payroll foundation (B27)**: company formula engine (fixed inputs/operators, no code execution), versioned rules with preview and confirmed activation, ticket ledger, periods, exceptions instead of guesses, owner approval and lock, CSV export by hash, reconciliation. **Top Line's rules not configured** (Discovery Report: no pay records available). | `20261118000200` local / not pushed / **not hosted** |
| `efd50de` | **Customer lifecycle (B53)**: four console KPIs, acknowledge ≠ resolve, versioned plans, subscription per company (plan, terms, offer, agreed amount), onboarding fee, go-live earlier-only, Go Live Now with password, daily scheduled activation, annual cancellation balance. No payment provider. | `20261118000300` local / not pushed / **not hosted** |

| `32459b7`, `0f6deb8` | Remove sample data releases sample tickets from open payroll (never approved payroll); payroll e2e uses its own customer and material | `20261118000400` local / not hosted |
| `e96f6a5` | Profile photo: frame before saving (zoom, position, preview, Save/Cancel) for every profile | none |

Release checks for `e96f6a5` (2026-10-19): lint + typecheck clean; vitest 752/752; full browser suite 159 passed / 1 failed /
9 skipped (command-center.spec:59 "Urgent" badge not found once at 00:24 UTC; passed on isolated rerun, cause not found —
watch it); production build OK; gate spec 8 passed / 1 skipped; risk tier APPROVAL (auth.ts, permissions.ts, vercel.json),
Production authorized by the owner on 2026-10-19 once gates pass.
**Released:** Preview `ce39234` (deploy 7163334449, success) and Production fast-forward `0ef6650..ce39234` (deploy
7163451156, success). Not verified live: this sandbox's network policy blocks `*.vercel.app` and `mytaviron.com`.
Hosted migrations `20261118000100`–`000400` are **not applied**; until the owner's `db push`, the Launchpad, payroll,
lifecycle and plans show their "needs a database update" state and the daily lifecycle cron answers 503.

| `6b8fab7` | **Company CRM slice 1 (B59)** — prospects, owner, tags, activity, follow-ups, opportunities, history, pipeline, export, duplicate check | `20261119000100` local / not hosted |
| `8052e65` | **One urgent indicator** in the Command Center strip (no "N urgent" + "N urgent orders" double count) | `20261119000200` local / not hosted |
| `b35b8a8` | Gap analysis (`docs/GAP_ANALYSIS_2026-10-19.md`) | — |

Release checks for `8052e65`+docs (2026-10-19): lint + typecheck clean; vitest 764/764; full browser suite 163 passed / 1
failed / 9 skipped (maintenance.spec:202 failed while a page was still navigating; 6/6 passed on rerun); build OK; gate 8/1.
**Released:** Preview `8489bbf` (deploy 7164654756, success) and Production fast-forward `ce39234..8489bbf` (deploy
7164672409, success). Not verified live (sandbox network blocks the domains). Migrations `20261119000100`/`000200` not hosted.

Owner steps: runbook §6 + §7 + §8 (`docs/runbooks/2026-10-14-hosted-db.md`) — one `db push` for six migrations; then Refresh
demo data in both demos. Payment provider choice (checkout, webhooks, 72-hour grace) is still yours (docs/PLATFORM_LIFECYCLE.md).

## 000000. Round 2026-10-15 (night) — job site directions verification (B51)

| Commit | What | Migration (local / pushed / hosted) |
| --- | --- | --- |
| `6d1a151` | **Site directions verification (B51)**: kind (standard / safety or access critical), verified by whom and when (only `verify_site_directions`, customers.edit, audited; a trigger refuses forged values and clears the check when directions change), review intervals per kind in Settings (empty = none), status on the customer, order and My Day (red line for unverified critical or overdue directions; never the verifier's name on the phone); demo samples on three sites, upcoming demo orders linked through the normal order edit | `20261115000200`: applied locally, rollback tested, **not applied hosted** |
| `01cb994`, next | Companion app doc, runbook §6 (both pending migrations + verification SQL), DEMO_TENANTS §5 row, master plan B51 row, feature catalog entry (`site-directions`, in development, not published) | — |

Checks: lint, typecheck, vitest 720/720, full browser suite 152 passed / 0 failed / 9 skipped, production build, gate 8
passed / 1 skipped. **Hosted-state check:** with `20261115000200` rolled back, customers, orders, driver portal,
branding and the presenter demo-parity specs pass and Settings saves; nothing B51 appears. Only B51's own assertions fail
there, as they should. Risk tier **REVIEW** (one hosted migration, owner action).

**Owner step:** runbook §6 — one `db push` applies `20261115000100` and `20261115000200`; run the five-line verification;
Refresh demo data in both demos.

## 00000. Round 2026-10-15 — master directive: companion app, HOS confirmation, board speed

| Commit | What | Migration |
| --- | --- | --- |
| `2d30c93` + next | **Companion app (B49)**: installable driver web app on the same backend (manifest, icons, service worker with offline page only, phone tabs for driver-only logins, Updated/stale/offline line on My Day, parked-only notice, dispatch updates with Got it / Got it for all). docs/COMPANION_APP.md | none |
| `bfa2b25` | **Hours of service in approvals (B50)**: Smart Dispatch and Plan the day approvals need the dispatcher's explicit confirmation (dialog; server refuses without it; note records "confirmed by the dispatcher (not verified by Taviron)"); `src/lib/hos` provider interface, source "none" | none |
| `0da3fce` | **Dispatch board 5–8 s → ~1.5 s (P8)**: page 10.7 MB → 2.2 MB (exclusions grouped by reason), Smart Dispatch lookups indexed (2.1 → 1.5 s at 143 loads, same rules), e2e setup cancels earlier runs' leftover fixture loads | none |
| next | Master plan: B1–B3, B6 reconciled against code, tests and CI (GitHub Actions CI runs and passes on both branches) | — |

Not built (decisions or credentials needed): invoice issuance/numbering (§9 Q10), driver pay (Q16), cost data (Q17), a
verified HOS source (Q20), QuickBooks (credentials + authorization), push notifications and native store apps
(COMPANION_APP §7), live HERE routing (key), AI evaluation (`npm run ai:eval` on the owner's computer).

## 0000. Evening round 2026-10-14 — trailer work orders (B48)

| Commit | What | Migration (local / pushed / hosted) |
| --- | --- | --- |
| `74d7e75` | **Trailer work orders**: a work order belongs to one truck or one trailer; a safety-critical trailer defect takes it out of service until cleared; trailer shop visits block dispatch on their day (DB codes + Plan the day + Smart Dispatch); trailer named across Maintenance, alerts, My Day; trailer profile shows its work orders; trailer driver reports offer Create a work order; demo Refresh adds one trailer inspection | `20261115000100`: applied locally, tested rollback, **not applied hosted** |
| `4ada09f` | E2E fixes: navigation tests search for the seed customer (leftover test customers pushed it off page 1); Reconsider allows the same recompute time as Reject; board speed recorded as master plan §8 P8 (measured: not caused by this round) | — |

Checks: lint, typecheck, vitest 700/700, full browser suite 143 passed / 3 failed / 9 skipped (all three fixed above and
re-run green), build, gate 8 passed / 1 skipped. **Hosted-state check:** with `20261115000100` rolled back, Maintenance,
Fleet, Dispatch, Plan the day, driver portal and demo parity specs pass (18), except the new trailer spec, which correctly
finds no Equipment choice; demo seed runs and skips the trailer sample. Risk tier **REVIEW**.

**Owner step:** runbook §6 (`docs/runbooks/2026-10-14-hosted-db.md`): `db push` for `20261115000100`, the two-line
verification SQL, then Refresh demo data.

## 000. Afternoon round 2026-10-14 (owner away; "resume full implementation")

| Commit | What | Migration (local / pushed / hosted) |
| --- | --- | --- |
| `900d773` | **Command Center ~4× faster** (root cause, not timeouts): billing views scoped per company, one line-status scan instead of four, visibility checked once per kind. Exceptions 1 251 → 326 ms, summary 1 859 → 479 ms locally (~3 800 orders); plan-shape test guards it | `20261114000100`, `20261114000200`: applied locally and **hosted (verified 2026-10-14)** |
| `871bb69` | **PTO work schedules** (B46): hours per weekday on the person page; full-day time off counts scheduled hours; demos get fictional schedules on Refresh | `20261114000300`: same (hosted, verified) |
| `1389c61` | Hosted DB runbook (`docs/runbooks/2026-10-14-hosted-db.md`); a customer who creates a company gets their own person record | `20261114000400`: same (hosted, verified) |
| `f54e2bd`, next | **Driver schedule notices** (B47): in-app alert to the assigned driver when a load is assigned or its date/time changes; repeat edits merge | `20261114000500`: same (hosted, verified) |

Every migration has a rollback tested apply → rollback → re-apply. **Hosted-state check:** all five rolled back
locally, then Command Center, People, time off and demo parity specs run (16 passed; the one failure is the work-schedule
spec, which correctly showed "needs a database update" instead of the form) and demo-samples DB tests 5/5; re-applied.

Checks on this bundle: lint, typecheck, vitest 692/692 (with storage), full browser suite 144 passed / 1 failed / 9
skipped — the failure (load builder freight approval waited > 10 s for its toast during the full run) passed 4/4 when
re-run alone; recorded, not a change in this bundle. Production build ok; gate spec 8 passed / 1 skipped. Risk tier
**REVIEW** (five hosted migrations listed as owner actions).

**Hosted database (owner, 2026-10-14 ~17:40 CDT):** `npx supabase db push` applied all pending migrations through
`20261114000500`; the runbook verification SQL returned all 11 checks `true`. Still to confirm: Refresh demo data in both
demos, Work schedule card and Command Center on the live site.

**Still waiting for the owner:** `npm run ai:eval` on your computer (this sandbox cannot reach
OpenAI, and no key is set here); HERE key in Vercel; choose an ELD/log source before any HOS rule (item 20).

## 00. Overnight session 2026-10-14 (owner asleep; working until 5 PM per the owner)

**Built and committed (local, then released as one bundle after the full checks):**

| Commit | What |
| --- | --- |
| `6ac1c51` | AI check fix: ISO dates were mistaken for phone numbers and blocked a valid answer in the owner's live eval (eval test set v2; earlier evidence no longer counts) |
| `5512a14` | **Route Planner** live (B10 first slice): per-truck routes from the board, straight lines until a HERE key is set, site/yard locations, migration `20261112000500_routing` (docs/ROUTING.md) |
| `fb051f7` | **Smart Dispatch tractors get a trailer** (Prairie Lantern showed "no feasible assignment" for every load); calmer proposal cards |
| `0ae3dcf` | Command Center queue as compact rows, neutral tiles; Smart Dispatch shows six loads then "Show all" |
| `db7cc0f` | Filter bars: search + actions on one line |
| `f526398` | **Load builder works for freight (per-load) and haul-only orders** |
| `31da587` | Fleet overview: capped lists, status labels (page 10 349 px → 1 765 px) |
| `a71eb9e` | Maintenance/tickets: neutral tiles, outlined row actions |

**Afternoon (owner's requests 2026-10-14), same bundle `54f3f2c..e044947`:**

| Area | What |
| --- | --- |
| **People** (B45, approved) | Employees → People; Add person sends a sign-in (ticked by default) with a role; every sign-in sent links or creates the record; Sign-in column; person page sends a sign-in or changes role/access; Settings → Users redirects to People → Sign-ins & roles. Migration `20261113000100_people` (backfill only) |
| **Settings** | Four groups (Company, Operations, Access, System); My account moved to My profile (change-password link there) |
| **Website** | Apple principles pass; generated-page tells removed (28 caps eyebrows, 5 arrows, near-black fills → navy tokens) |
| **Design skills** | frontend-design, ui-ux-pro-max, ckw-design, impeccable (modified), taste-skill: reviewed, markdown only; provenance and overrides in `.claude/skills/TAVIRON-NOTES.md`. better-ui and variant could not be fetched |
| **Fixes** | Toasts top centre below the header (covered page actions); approved Smart Dispatch card hides at once; Command Center reasons kept (two lines); `withReturn` keeps `#section`; Needs scheduling opens the chosen day (push was cancelled by a refresh) |
| **Owner rule** | Send screenshots of every visible change (CLAUDE.md) |

Checks for `e044947`: lint, typecheck, 684 unit/DB tests, full browser suite (140 passed; the 2 failures fixed and their
specs plus every return-link spec re-run green), production build, gate spec. Risk tier: REVIEW.

**Later release `e8c09a1` (owner approved the approval-tier promotion, 2026-10-14):** sentence-case labels app-wide,
neutral Billing tab counts, Order to cash limit as one line, one filled action on the order page, role label "Driver".
Checks: 684 unit/DB, full browser suite 144 passed, build, gate. Production deployment record: success (not verified
live: vercel.app is blocked from the sandbox). Command Center speed recorded as master plan §8 P7.

**Waiting for the owner:**
1. `npx supabase db push` for `20261112000500_routing` and `20261113000100_people`, then **Refresh demo data** in both demos.
2. AI: rerun `npm run ai:eval` (test set v2) with the credits; paste only the evidence block.
3. HERE key for road routing (docs/ROUTING.md §4).
4. Website: the hero lost its "for haulers" label; say if you want it back as a sentence.

## 0. Current checkpoint (2026-10-13 evening: Preview release, then the authorized product backlog) — read first

**Deployment state (verified from GitHub's deployment records, 2026-10-13 22:48 UTC):**
- **Preview** (`claude/ui-and-signin-checkpoint`) runs **`95320c4`** — deployment record `7051985355`, environment
  Preview, state **success**. Pushed after the full release suite passed on that exact commit (lint, typecheck,
  vitest 647/647, browser 130 passed / 0 failed / 9 skipped (gate, run separately: 8 passed / 1 skipped), production
  build, deployment check all passed). Not verified live: this sandbox's network policy blocks `*.vercel.app`.
- **Update 2026-10-14:** `54f3f2c` (full release suite passed: vitest 669/669, browser 139 passed / 0 failed / 9
  skipped, gate 8/8, build, lint, typecheck) was pushed to Preview (record `7054264731`, success) and, at James's
  explicit request, fast-forwarded to **Production** (record `7055955005`, success). Not verified live from the sandbox.
- **Production** (`claude/top-line-trucking-manager-vmw04i`) previously ran **`651c37b`**. Promotion of `95320c4`
  (a fast-forward, risk tier REVIEW) was attempted under the owner's release authorization and **denied by this
  session's permission system** ("Production Deploy"). It needs the owner to promote, or to allow the action.
- **Hosted database:** cannot be reached from this sandbox. **James applied `20261110000100`–`20261111000300` on
  2026-10-13 (his `migration list` shows them on both sides).** Still pending, all optional and reversible:
  `20261112000100_pto_balances`, `20261112000200_document_policy`, `20261112000300_pto_accruals`,
  `20261112000400_time_off_approval_chain`. Code works without
  them (hosted-state check: all six earlier ones rolled back locally, 39/40 affected browser tests passed; the 40th
  needed the PTO update and now accepts the documented "not available yet" state).

**Built after `95320c4` (local commits, in order):**

| Commit | What users can do |
| --- | --- |
| `7363766` | Plan the day: optional **Keep crews together** priority (off by default; plans unchanged at 0) |
| `8409507` | **PTO banks and balances**: banks (separate/combined, eligible employment types, waiting period), append-only ledger, grants/adjustments, requests refused beyond available hours, approval posts usage, cancel returns it; My balances; Banks and balances page |
| `2449777` | **Expired vehicle documents policy**: per-kind block/warn rules (Settings → Dispatch rules), "Mark verified" in Fleet, enforced in the database and mirrored in Smart Dispatch and Plan the day |
| `db08901` | Unfinished modules say **Coming soon** (Route Planner) |
| `855f97b` | Demo-parity test accepts the "not available yet" state before the hosted update |
| `3abbc40` | **PTO accruals**: annual grant / hours worked / per pay period per bank and employment type, caps, plan-year carryover (forfeiture only after the company confirms legal review), record hours, idempotent run |
| `499e5e7` | **Time-off approval chains** (Settings → Time off): ordered steps by role; only the last step approves; denial at any step ends it |
| `09a682c` | **Order to Cash** control center (B42 increment 1, read-only lifecycle; invoices/payments labelled Coming soon) |
| `1b1a47e` | **Demos:** Northfield matches Prairie Lantern (fleet, trailers, charges, its own Refresh); Prairie Lantern personalised for Colby Chapman (Southfield/Sarasota lanes, a hardwood-court customer, his friend Cam Webster as a driver — the one real name, owner request) |

**Verification on `3abbc40`:** lint and typecheck clean; vitest **664 / 664** (88 files). Full browser suite: see
the release record below (updated when it finishes).

**Feature catalog:** public claims for balances, accruals and the document policy are not added yet — they depend on
hosted migrations that are not applied (never call a feature operational before that).

**Decisions for James:**
1. **Production:** promote `95320c4` (or a later verified Preview) — the session could not (permission denied).
2. **Hosted migrations** (in order, backup first, DEPLOYMENT §2a): the four earlier optional ones, then
   `20261112000100` → `000200` → `000300`; then Refresh demo data. Or add `SUPABASE_ACCESS_TOKEN` and
   `SUPABASE_DB_PASSWORD` to the environment so a future session can run them with your approval.
3. **Still open (not invented):** payroll/ELD hours
   integration source, invoicing/payments scope for B42 (§9 Q9, Q10, Q15).

## 0b. Earlier checkpoint (2026-10-13 daytime sprint, until 5 PM America/Chicago)

**Deployment state.** The owner said "push it" after the overnight sprint: `651c37b..7eba5e4` was pushed to the Preview
branch `claude/ui-and-signin-checkpoint` (fast-forward) and Vercel's Preview deployment for `7eba5e4` reports
**success** (GitHub deployment record). It was **not verified live** (this sandbox cannot reach `*.vercel.app`).
**Production still runs `651c37b`.** This sprint's instruction forbids pushing, deploying, promoting or hosted
migrations: everything below is **committed locally only** on top of `7eba5e4`.

| Commit | What |
| --- | --- |
| `b490f97` | Migration `20261111000100_demo_driver_names` (+ tested rollback): in demo companies driver lists show the persona (Daniel Mitchell), not the presenter's login name |
| `965db0f` | Plans: B42 readiness map (`docs/proposals/B42_ORDER_TO_CASH_READINESS.md`), expired-document recommendation (§9 Q23), backlog row B44 |
| `754f537` | Resources: note when a driver's primary truck cannot run that day; Plan the day: plain error message, notice when the requested day is replaced |
| `9b1b047` | Homepage: opening shot keeps the whole truck in frame (nose was cut at 1280–1440 px) |
| `1202869` | Sidebar e2e: first hover retried until hydrated (failed once under full-suite load) |
| `40cd70a`, `73801f6` | Plan the day and Smart Dispatch: a driver whose employee record says On leave gets a review note / warning (never a block) |
| `c445593` | All 13 website screenshots re-captured from the current build (quality gate passed) |
| `d2dd2e8`, `b9d4ea1`, `c92db1c`, `4df6ab3` | Demo samples (every demo, via Refresh): an order Ready to bill and one Handed off; a sent quote with a locked v1; an attention item assigned to the viewer; a confirmed order waiting for a date |
| `69e9ba5` | Local stack: `jit = off` for the dev database (JIT compile 4.9 s on a 0.16 s billing query) |
| `4e1099c`, `5b82500`, `c475ea0` | Plan the day about 20× faster on larger fleets (exact incremental move scoring; plans byte-identical to before) |
| `e808488` | Dispatch and Company setup: plain error messages instead of raw database text |
| `93963a1`, `36e4241` | Migrations `20261111000200_demo_people_names` and `20261111000300_demo_history_names` (+ tested rollbacks): the demo persona name in the Command Center, Reassign list, history, field reports, My Day, urgent orders and assignment history |
| `31082f7` | All 13 website screenshots re-captured from a fresh demo |
| `4ff8ec3`, `4d22ebc` | Phone layout: a very long customer name no longer widens Billing and the Command Center (525 px); e2e `long-names.spec.ts` |
| `f8b349f`, `4fbd8a9` | Dark mode: three warning alerts had near-black text; theme test fixed to read the dark palette block (the earlier commit message wrongly said the old test failed on the old code — it passed vacuously; `4fbd8a9` makes it fail when an unmapped shade is restored) |
| `6dbb159`, `67d2110` | Proposals: hosted JIT check (`docs/proposals/hosted-jit.md`), "Keep crews together" (`docs/proposals/crew-continuity.md`) |
| `7f0ffe5` | Plan the day ~5× faster with large fleets: Top Line test company (20 loads × 227 trucks × 149 drivers) 13.4 s → ~2.7 s, plans byte-identical; `optimization-feasibility.test.ts` (per-part check = `checkAssignment` for every combination; scale test fails on the old code at 30 s) |
| `c7db0b5` | Dispatch board on phones: a very long driver or truck name wraps instead of pushing the Drivers today list 31 px sideways and cutting off its badge (found by a sweep; `long-names.spec.ts` fails without the fix) |
| `f40aacc`, `45a302a` | Handoff, implementation plan §5ah and master plan B44 brought up to date |

**Findings recorded, not changed (decisions):** expired vehicle documents block nothing (recommendation in master plan
§9 Q23); the planner may put one truck through a day with a different driver per load, because driver–truck pairing
is open decision §9 Q20 (recommend a soft preference for keeping a driver on their primary truck).

**Final verification on `af9f377` (local, 2026-10-13, 17:30 UTC; all on the same commit):**
- `npm run lint` clean; `npx tsc --noEmit` clean; `npx vitest run`: **646 / 646** (85 files, unit + DB + storage).
- Full browser suite (`npx playwright test`, dev server): **130 passed, 0 failed, 9 skipped** — the 9 are `gate.spec.ts`,
  which runs separately against a gated production build: **8 passed, 1 skipped** (the "no shared password
  configured" case needs a server without it). `check-deployment.mjs` against that build: **all checks passed**.
- `npm run build` passes. `risk.mjs 651c37b`: tier **REVIEW**; hosted migrations in range: `20261110000100_ai_usage`,
  `20261111000100`, `000200`, `000300` (all optional, owner applies).
- Earlier full runs today, for the record: 129/1/9 (prospect-demo test timed out at 15 min once; passed alone and in
  sequence; its retire loop is now bounded, `08256e6`), then 126/2/9 (breadcrumb test lost a race with hydration —
  fixed in the test, `af9f377`; one sign-in timeout that passed in five reruns). One commit message (`f8b349f`) wrongly
  said the old theme test failed on the old code; it had passed vacuously — corrected in `4fbd8a9`.
- Plan the day page on the production build (Top Line test company): 9.9 s with 16 loads × 327 trucks × 224 drivers
  (the shared e2e company grows with every run; the same page was 12.8 s this morning at 227 × 149). Same-input
  comparison: 13.4 s → 2.7 s. Every other page under 1.1 s.
- Not verified live: Preview `7eba5e4` (sandbox cannot reach `*.vercel.app`). Nothing after `7eba5e4` is pushed.

### Release report (DEVELOPMENT_WORKFLOW §6) — local bundle `7eba5e4..af9f377`

```
Feature: B44 release-readiness sprint — demo persona everywhere, dispatch edges, planner speed, phone/dark-mode fixes
Changed: demo samples (billing states, sent quote, assigned item, waiting order); persona names (3 migrations);
  Resources primary-truck note; Plan the day plain errors, replaced-day notice, On-leave review note, ~20× / ~5× faster;
  phone layout (long names), dark-mode alerts, plain error messages; 13 screenshots; homepage opening shot
Commits: 7eba5e4..af9f377 (local only) · Preview: 7eba5e4 · Production: 651c37b
Risk tier: REVIEW; approvals outstanding: push (owner), promote (owner), hosted migrations (owner, optional)
Tests: lint ok · tsc ok · vitest 646/646 · browser 130 passed / 0 failed / 9 skipped (gate, run separately: 8/1 skipped)
  · build ok · check-deployment all passed
Demo modes: all six previews; samples via ensureFeatureSamples (presenter seed, prospect seed and Refresh)
Deployment: nothing pushed or deployed by this sprint (owner instruction)
Verified: local only; not verified live
Limitations: hosted demos show the presenter's login name in some places until the 3 migrations are applied
Rollback: Vercel instant rollback; each migration has a tested rollback in supabase/rollbacks/
Next: owner decisions below; then B42 only when authorized
```

**Hosted-state check (2026-10-13, local).** Hosted databases do not have `20261110000100_ai_usage` or the three
demo-name migrations yet. With those four rolled back locally (backup
`/var/lib/tlt-backups/pre-hosted-state-20261013145827.dump`), the affected browser specs (demo-parity, plan-the-day,
dispatch, smart-dispatch, dispatch-availability, coordination, billing, long-names, demo-experience) passed
**26 / 26** — the code works without them; demos then show the presenter's login name in the places listed in
decision 2. Migrations re-applied afterwards; demo-samples, tenancy, ai-usage, quotes and fleet DB tests **48 / 48**.

**Sweeps (2026-10-13 afternoon, production build).** Presenter demo, all six role previews: 82 pages at desktop,
phone and tablet plus 35 detail pages — no console errors, no failed (4xx/5xx) requests, no sideways scrolling (now
also inside scrolling lists). Top Line test company at phone/tablet, 17 pages + 21 detail pages: one finding, fixed
in `c7db0b5`. Page times (Top Line, production build): every page under 0.9 s except Plan the day (12.8 s before
`7f0ffe5`; the planner part is now ~2.7 s).

### Decisions for James (current, with recommendations)

1. **Promote to Production?** Preview runs `7eba5e4` (deploy record: success, not verified live). Check it on the
   iPad; if good, say "promote" and Production is fast-forwarded to it. The commits made after `7eba5e4` need a
   separate "push" (they are local only, by instruction).
2. **Hosted migrations `20261111000100_demo_driver_names`, `20261111000200_demo_people_names` and
   `20261111000300_demo_history_names`** (optional, reversible, tested rollbacks; apply in order): every demo page
   then names the presenter as the persona (driver lists, Command Center, history, field reports, My Day, urgent
   orders). Without them hosted demos show the presenter's login name in those places. Real companies unchanged
   (except the Command Center preferring a person's own display name, as Communications does). Recommended: apply with the next release (DEPLOYMENT §2a).
3. **JIT on hosted Postgres.** Locally, JIT compilation cost 4.9 s per billing/Command Center query (the query runs in
   0.16 s). Read-only check, exact SQL and rollback: `docs/proposals/hosted-jit.md`. Recommended: check; if `jit` is
   on, turn it off for the app's roles. Not done: it is a hosted database setting.
4. **Expired vehicle documents** (master plan §9 Q23): recommended — block expired insurance and registration once
   verified, warn for inspections and permits. Nothing blocks today.
5. **Driver–truck pairing** (§9 Q20): the planner can give one truck a different driver per load in one day.
   Recommended: an opt-in priority "Keep crews together" (default 0, so plans are unchanged until turned up);
   design in `docs/proposals/crew-continuity.md`.
6. **AI** (unchanged): hosted migration `20261110000100_ai_usage`, a model with a passing eval, Vercel variables.

### Release checklist for this bundle (Preview → Production)

Local, before any push (all must pass on the final commit): `npm run lint`, `npx tsc --noEmit`, `npx vitest run`,
`npx playwright test`, `npm run build`, gate spec on a production build, `node scripts/check-deployment.mjs
<local prod URL>`, `node scripts/release/risk.mjs`. Then, only with the owner's "push": push the Preview branch
(fast-forward), confirm the GitHub deployment record for the commit is `success`, have the owner check Preview on the
iPad (this sandbox cannot open `*.vercel.app`), and only on "promote" fast-forward the Production branch and confirm
its deployment record. After Production: owner applies the hosted migrations they approve (backup first,
DEPLOYMENT §2a) and runs **Refresh demo data** on Prairie Lantern Freight so the new samples (billing states, sent
quote, assigned item, order waiting for a date, planning day) appear.

## 0. Previous checkpoint (2026-10-13, overnight sprint)

**Local commits on `claude/ui-and-signin-checkpoint`, not pushed** (Preview and Production both run `651c37b`):

| Commit | What |
| --- | --- |
| `e78615c`, `79f5aac` | AI runtime foundation, inactive (every capability Blocked); release-risk rule for AI code |
| `040b701` | Sidebar: expand/collapse toggle for touch screens (iPad in landscape) |
| `46b01f4` | Plan the day: blocked-load reasons, resources unavailable all day, Show plan button, loading and empty states; Order-to-Cash queued as B42 |
| `c9f25bf` | Plan the day: freight revenue from hauling lines; expired vehicle documents as review notes; touch sidebar tests |
| `e80b9b7` | Homepage 3D: one scene per chapter in step with the text; phone stacking and tablet overflow fixed |
| `b699785` | Handoff, master plan statuses, pending decisions |
| `6b1a3b6`, `f853b16` | Marketing: feature catalog (`src/lib/site/features.ts`), screenshot list with a quality gate, capture script fixed, `/platform` generated from the catalog, 8 verified screenshots (3 new), catalog and marketing tests (docs/MARKETING.md) |
| `bf7bc63` | Demo parity e2e: read the sidebar once the page has settled (dev-server reload) |
| `84806c7`, `b699785`, `39c5a4a`, `d56c387` | Handoff, master plan B43, implementation plan §5ag |
| `7d13db2` | Demo parity e2e: one shared `sidebarHrefs()` helper |
| `3453d68` | Billing and Communications screenshots |
| `051dbda` | Homepage: capability index from the catalog; homepage screens take their alt text and captions from it |
| `ee168de` | Employees, Reports and Company setup screenshots: every published capability now has a real screen (13 shots) |

**Verification on this bundle (local, 2026-10-13):**
- **Lint and typecheck:** clean.
- **vitest:** 639 / 639.
- **Production build:** passes.
- **Gate spec on the production build:** 8 passed, 1 skipped (public-site case).
- **`check-deployment.mjs`:** all checks passed.
- **Full browser suite, first run:** 126 passed, 1 failed, 9 skipped. The failure was a test-side race (dev-server reload during a read); fixed, and the test re-run passed.
- **Final full browser suite on the complete bundle:** 129 passed, 0 failed, 9 skipped (conditional skips).
- **After `ee168de` (site-only change):** lint and typecheck clean; unit tests 365 / 365; production build passes;
  marketing and homepage browser specs 7 / 7; `/platform` checked at desktop and phone (no sideways overflow).
- **Final checks on `39c5a4a`:**
  - vitest 639 / 639;
  - build passes;
  - gate spec 8 passed, 1 skipped;
  - `check-deployment.mjs` all checks passed;
  - release risk tier REVIEW, with no approval-tier item. The only hosted migration is `20261110000100_ai_usage`, and
    it is optional while AI is off.
- **Local database:** the gate spec failed only because the bloated local database made the Command Center take 12 s. The database was backed up (`/var/lib/tlt-backups/pre-release-reset-20261013040157.dump`) and reset, as SETUP §5 prescribes. The whole migration chain re-applied cleanly, and the gate spec then passed.

**Found, not fixed (next):** in the presenter demo the header shows the persona name, for example "Daniel Mitchell", but
lists that name the presenter as a driver show the login's own name (Plan the day proposals, Delivery Tickets). Small
demo-consistency gap; the screenshots use a plain-named local capture account, so they are unaffected.

### Pending decisions (owner) — one list, kept current

1. **Push this bundle to Preview, then Production?**
   - **Recommended:** push all of it once the full browser suite is green, check Preview on the iPad, then promote.
   - **Why it is a decision:** the AI-foundation request said it was "not authorization to deploy", and those commits
     sit in this branch.
   - **Why it is safe:** with no AI settings, the AI code is inert (Blocked, verified in a browser), and it works
     without its migration (hosted-state check, 2026-10-13).
   - **Options:**
     - (a) push everything (recommended);
     - (b) hold everything until you have looked;
     - (c) rebuild the branch without the AI commits. This is a local history rewrite; not recommended.
2. **Expired vehicle documents.**
   - Today an expired registration, insurance, inspection or permit on record is only a **review note** in Plan the
     day. No assignment rule checks documents, in the planner or in the database.
   - Should expired registration or insurance **block** assignment? That is a business rule, so it is your call.
   - **Recommended:** block expired insurance and registration in `assign_load`, keep inspections and permits as
     warnings.
   - Until you decide, nothing blocks.
3. **AI (when you want it):** the hosted migration `20261110000100_ai_usage.sql`, a model choice with a passing
   `npm run ai:eval`, and the AI variables in Vercel (docs/AI.md §12). Until then AI stays off. Nothing is waiting on
   it.
4. **After any deployment (owner action, not a decision):** run **Refresh demo data** on Prairie Lantern Freight, so
   tomorrow has plannable loads and the new blocked and unavailable views have sample data.

### Briefings (phone notifications, owner 2026-10-13)

- **Mechanism:** the session's push tool. It returns "push requested" and gives no delivery receipt, so delivery is
  unconfirmed.
- **Schedule:** two-hour self check-ins during the sprint (`send_later`); stopped at sprint end (05:55 UTC).
- **Rule:** one alert per issue; repeat only when its severity changes.

| UTC | Kind | Sent |
| --- | --- | --- |
| 05:55 | final | Sprint finished. Everything committed locally, nothing pushed or deployed. Your decisions: push the bundle (1), expired documents rule (2). The two-hour check-ins have stopped. |
| 05:19 | progress | All release checks green on the local bundle (639 unit, 129 browser, build, gate). Marketing catalog, new platform page, 10 real screenshots. Push awaits OK. (Check-in moved to 07:20 UTC.) |
| 03:32 | progress | Plan the day fixes, iPad sidebar toggle, homepage 3D done (633 tests pass; browser suite running). Next: marketing feature catalog. Push awaits OK. |

### Queued, not started (owner instructions)

- **B42:** Order-to-Cash Control Center.
- **EDI Decisions 61–70 and 71–80:** backlog only, with no repository changes allowed. Recorded in the session task
  list and the session scratchpad. They go into the master plan only when you allow it.

## 0a. Earlier checkpoint (2026-10-12)

- **2026-10-13, AI runtime foundation (docs/AI.md, master plan B6):**
  - Built: provider-independent interface, OpenAI adapter (Responses API, `store: false`), server-only configuration,
    readiness gates (Ready / Limited / Needs review / Blocked), tool registry (read / propose / execute with approval),
    evaluation runner, usage ledger with monthly token cap, per-minute rate limit and cost estimates, and the first
    capability, "Explain this plan" on Plan the day. Migration `20261110000100_ai_usage.sql` is applied to the
    **local** database only.
  - Status: committed locally, not pushed, not deployed. No real OpenAI call was made; no evaluation evidence exists,
    so every capability shows **Blocked** (no provider configured) everywhere, demos included.
  - Owner actions before it can run (each needs approval): apply `20261110000100` on hosted (back up first); choose a
    model and run `npm run ai:eval` with a key; set `AI_PROVIDER`, `OPENAI_API_KEY`, `AI_CAPABILITIES`,
    `AI_MODEL_PLAN_EXPLANATION` and `AI_MONTHLY_TOKEN_LIMIT` in Vercel; then deploy and verify (docs/AI.md §12).

- **2026-10-13:** Production promoted to `db7990b` (deployment record: success). The owner applied hosted migrations
  `20261108000100` and `20261109000100` (`20261107000100` was already applied); `migration list` shows every
  migration Local and Remote. The owner then ran **Refresh demo data** on Prairie Lantern Freight and added
  `CRON_SECRET` in Vercel (takes effect with the next deployment; check one cron run after it).

- **Communications hardening** (IMPLEMENTATION_PLAN §5ac, docs/COMMUNICATIONS.md): fixed 5-minute edit/delete
  window, manager removal with a required reason (audited, tombstone), 14-day message content retention enforced at
  read time and purged by a job (attachments, revisions, search; legal hold overrides; audit kept), scheduled job
  `/api/cron/comm-housekeeping` (Vercel Cron daily, optional pg_cron), archive veto for outstanding actions, driver
  handoff message and inherited history, presence colours (Busy red, Away yellow) and the dot on the top-bar picture,
  "Show earlier messages", collapsible threads, demo sample channel. **Not live until the owner applies
  `20261107000100` then `20261108000100` and sets `CRON_SECRET`** (DEPLOYMENT §2a); until then hosted Communications
  keeps the earlier rules.
- **Demo experience** (IMPLEMENTATION_PLAN §5ae): the header shows the person's own profile photo in demos too (it
  showed initials for Colby Chapman); the yellow demo bar is replaced by a one-time welcome dialog, a small "Demo"
  badge, and **Change view** / **About this demo** / **Presentation mode** in the profile menu. **Owner action:** apply
  `20261109000100` (after `20261108000100`) so the welcome is remembered per account; until then a browser cookie
  remembers it.
- **Demo feature parity in every demo mode** (permanent rule, IMPLEMENTATION_PLAN §5ad, DEMO_TENANTS §3/§5): shared
  idempotent samples (`src/server/demo/samples.ts`) used by both seeds and Refresh, persona names in Communications,
  prospect owners join the sample workspaces. **Owner actions:** after applying `20261107000100` and
  `20261108000100`, run **Refresh demo data** on Prairie Lantern Freight so every demo mode shows the samples.
- **Session 3 (2026-10-12, 20:15 UTC onward):**
  - Released `e5991fc` to Production (20:31 UTC) after a reset local database ran every gate clean (vitest 530/530,
    browser 102 passed / 0 failed / 10 skipped, build, gate spec, deployment check, CI, Preview record).
  - Fixed: employee pages request only existing photos (`profile_photo_versions`, in unapplied `20261107000100`);
    Channels have their own unread badge (Messages no longer shows channel counts over an empty list); dark mode
    no longer uses Tailwind `dark:` (misfired with the person's theme choice) and critical text is legible there;
    profile photo input labelled; public lead form hints meet AA contrast.
  - Sweeps run clean after fixes: every app page for dispatcher/office/mechanic/driver/owner (axe, phone width,
    console, failed requests), dark mode and Light-on-dark-device, public site and sign-in, `/admin`, and a
    brand-new empty company (every page loads). A Prairie Lantern walkthrough as a fictional prospect owner worked,
    including the sample channel.
  - Reviewed: `npm audit` (dev-only lint chain, no runtime exposure — master plan §8 S5); O2 already covered by the
    Command Center; O11/O12 explained by test-data volume (SETUP §5: reset before release runs).
  - Released `e41e44f` to Production (21:42 UTC) after a second clean gate run (vitest 532/532, browser 106/0/10).
  - **Hosted-state check:** ran today's code against a local database *without* `20261107000100`/`20261108000100`
    (Production's real state). Found and fixed: managers could not remove messages at all there (the call with a
    reason failed) — now falls back to the earlier function and says the reason is not recorded. The
    `demo-owner` script falls back the same way. Everything else degrades as documented.
  - Cleanup job: partial failures now answer 500 and log company ids and counts, so Vercel shows failed runs.
  - Released `e468636` to Production (22:38 UTC; manager removal fallback, cleanup observability, script fallback,
    10 s e2e assertion wait) after a third clean gate run on a reset database (vitest 533/533, browser 106/0/10,
    build, gate spec 8/1-by-design, deployment check, CI, Preview record).
  - **State at the end of session 3:** Production `e468636`; Preview `100f781`+ (e2e test for the cron route's
    refusals and these notes — tests/docs only). Hosted migrations `20261107000100` and `20261108000100` and
    `CRON_SECRET` are still the owner's actions (DEPLOYMENT §2a).
- **Release status (2026-10-12 19:37 UTC):** Production = `78aa207` (Communications hardening + phone layout fix;
  Vercel Production deployment record: success). Preview is ahead with `c276e59` (demo owners join the sample channel —
  part of the still-unapplied migration `20261108000100`) and `bf6ded9` (accessibility fixes, steadier e2e tests);
  promote them with the next release after the full checks.
- **Accessibility sweep (axe, WCAG 2 A/AA, 13 main pages as owner):** fixed the only findings — unfocusable scroll
  areas on Communications, links nested in the Smart Dispatch summary, unmarked disabled pagination buttons.
- **Autonomous sprint findings (2026-10-12, evening):**
  - CI's `database` job had been red since before `43ca9fd`: `tests/db/platform.test.ts` compared names sorted
    in the server's collation (CI's Postgres sorts case differently from the local C collation). Fixed (`collate "C"`);
    CI is green again from `fa7b8ca`.
  - Vercel deployments are queued, not lost: Preview records appeared 20–40 minutes after each push. A missing record
    a few minutes after a push is not a failure; wait before diagnosing. (`vercel.json` was briefly removed while
    diagnosing and restored — it was not the cause; `25a83df` deployed with it.)
  - Communications home and conversation pages were wider than a phone (579 px on 390 px): fixed with a single-column
    grid below the wide breakpoint (same pattern fixed on maintenance, time-off, load build and admin pages); a phone
    width regression test was added.
  - Fixed (needs migration `20261107000100`, still unapplied): employee pages requested `/people/photo/<user>` for
    every linked person (a 404 per person without a photo). `public.profile_photo_versions` (same rule as
    `profile_photo`) lets them request only existing photos with a versioned URL; until applied, they behave as before.
  - Since implemented (2026-10-13, IMPLEMENTATION_PLAN §5ae): the demo welcome dialog, "About this demo" and
    "Change view" in the profile menu replace the demo bar.
  - The sandbox cannot reach `*.vercel.app` (network policy), so deployed pages were not opened in a browser here;
    releases are verified by GitHub deployment records plus the local production build, gate spec and deployment check.
- **Permanent rule — demo tenants stay in sync** (CLAUDE.md, docs/DEMO_TENANTS.md): every feature/UI change must
  work in demo companies (or document an exception), add sample data to the seed and to Refresh demo data, and pass
  `tests/unit/demo-parity.test.ts` and `tests/e2e/demo-parity.spec.ts`. Known gaps: DEMO_TENANTS §4.
- **Prospect demo tenant for Colby Chapman — Prairie Lantern Freight** (IMPLEMENTATION_PLAN §5ab, DEPLOYMENT §3c):
  released. The owner applied the migrations up to `20261106000100` and created the tenant on 2026-10-12 (before the
  logo and data update). **Next migration `20261107000100`** (photos in Communications, `demo-owner --name`, Retire a
  prospect demo) — then retire the old tenant and create it again (DEPLOYMENT §3c step 0). **Colby's login does not exist yet.** Decided 2026-10-12: he signs in with the username
  `colbychapman` (username sign-in, `src/lib/usernames.ts`; no email needed). Steps (DEPLOYMENT §3c, owner actions):
  create the tenant in /admin/demo → `setup-link colbychapman` (he sets his own password) → `demo-owner colbychapman
  <slug>` → verify his sign-in. Username accounts have no reset email; a new setup link replaces it.
- **Employee Communications** (IMPLEMENTATION_PLAN §5aa, docs/COMMUNICATIONS.md): messages, groups, channels,
  dispatch-linked operational workspaces, operational alerts with safety minimums and escalation, announcements with
  acknowledgment, presence and work status, driver-on-delivery safety notice and deferral, preferences, quiet hours,
  mutes, search (audited admin search), private attachments, retention. In-app only — nothing is emailed or texted.
  Its four migrations (`20261105000100` … `20261105000400`) were applied by the owner with those through
  `20261106000100`. Open decisions: master plan §9 Q25.
- **Driver time off** (IMPLEMENTATION_PLAN §5z): `/time-off` requests and approvals; approved leave blocks drivers in
  dispatch at the moment of assignment. **Needs migration `20261104000100_time_off.sql`** after the three pending
  ones (20261101000100 → 20261102000100 → 20261103000100). No balances or accruals yet. Open decisions: master plan §9 Q24.
- **Smart Dispatch maintenance awareness + Driver & truck availability** (IMPLEMENTATION_PLAN §5y). **Needs
  migration `20261103000100_dispatch_maintenance.sql`**, after `20261101000100` and `20261102000100` (owner action,
  DEPLOYMENT §2a). Without it dispatch works as before and says shop visits are not checked. Hours of service are
  never verified (no ELD data); PTO is not recorded.
- **Fleet Management (code released to Production with this checkpoint under the standing release rule in CLAUDE.md; hosted migrations still pending):** vehicle documents with expiry warnings (metadata, no
  upload), ownership, driver assignment with history and atomic reassign, availability derived from service status
  and maintenance, maintenance/readings/costs/downtime on truck profiles, new overview cards and directory filters
  (IMPLEMENTATION_PLAN §5x). **Needs migration `20261102000100_fleet_management.sql`** after
  `20261101000100_maintenance.sql` (owner action, DEPLOYMENT §2a). Without it Fleet works as before and the new
  sections say they are not available yet. Open decisions: master plan §9 Q23.
- **Mechanics & Maintenance (code on Preview and Production since `528098c`; hosted migration pending):** `/maintenance` with work orders, clearance queue,
  preventive schedules, readings, cost lines and a driver notice on My Day (IMPLEMENTATION_PLAN §5w). **Needs
  migration `20261101000100_maintenance.sql` on each hosted database** (owner action after a backup, DEPLOYMENT
  §2a; rollback script in `supabase/rollbacks/`). Until then the Maintenance entry is hidden (no permission) and
  My Day shows no maintenance notices. Open defaults to confirm: master plan §9 Q22.
- **Branches:** work and pushes on `claude/ui-and-signin-checkpoint` (Preview). Production
  (`claude/top-line-trucking-manager-vmw04i`, mytaviron.com) is still at `16fc188`; Release 1
  (`3b33dfc`: new layout, Load Build, sign-in fixes; no migration) awaits the owner's go-ahead.
- **Admin accounts:** `scripts/platform-admin.mjs setup-link <email> --base-url https://mytaviron.com`
  prints a one-time password-setup link (creates the login if needed); then `grant`. The documented
  placeholder `you@example.com` must be revoked on staging if it was ever created (owner).
- **Email:** Resend domain `mytaviron.com` verified (owner). App emails (leads, quotes) use
  `EMAIL_PROVIDER`, `RESEND_API_KEY`, `EMAIL_FROM`, `EMAIL_REPLY_TO`, `LEAD_NOTIFY_EMAIL`,
  `EMAIL_TEST_RECIPIENT` (test mode: lead and quote emails only go to that inbox), `APP_BASE_URL`.
  A malformed value in any of these stops the server rendering pages (env validation). Supabase Auth
  emails (invitations, resets, confirmations) do **not** use these: they need Supabase → Authentication
  → SMTP (Resend SMTP) and URL Configuration (owner, not done). No delivery verified from a session.
  Branded HTML lead emails: `5c7ac2c` (Preview only).
- **Sidebar, greeting, profile self-service (Preview, not Production):** collapsible desktop rail
  (hover/keyboard expand, pin stored in a cookie), "Hi, <first name>!" / "Welcome back!", `/profile`
  (photo resized in the browser, display name, phone). **Needs migration
  `20261030000100_profile_self_service.sql` on staging before it works there** (back up first,
  DEPLOYMENT §2a; rollback script in `supabase/rollbacks/`). Without it the app works and `/profile`
  says editing is not available yet (tested). No PTO exists, so none is shown.
- **Email settings fail safe (b51a5d4):** only the Supabase URL and anon key are required to start. A
  malformed optional setting is ignored and named (never its value) in the server log; any malformed
  email setting (including `EMAIL_TEST_RECIPIENT`, `LEAD_NOTIFY_EMAIL`, `APP_BASE_URL`) turns sending
  off entirely. In test mode, invitations (Supabase Auth) are refused except to the test inbox; password
  resets and sign-up confirmations are self-initiated and still go to the requester's own address.
- **Phone fields** format US numbers as typed; `+` numbers and extensions kept; profile requires a
  complete number. **Navigation:** breadcrumbs return to the remembered list view; phones show one
  back link; forms marked `data-guard-unsaved` warn before leaving with edits.
- **Production released 2026-10-11 20:45 UTC: `96d3ee8`** (Vercel deployment success; live check
  not possible from the session — network policy). Migration `20261030000100` still unapplied on
  staging (app degrades gracefully).
- **Employees (Preview):** `/employees` directory (search, status/department/driver filters),
  profiles, add/edit, confidential pay (`employees.compensation`), drivers' primary trucks
  (`fleet.assign`). **Needs migration `20261031000100_employees.sql` on staging** (after
  `20261030000100`); without it `/employees` errors, so do not release it before the migration.
- **Northfield demo (Preview):** "Start the demo" (`/admin/demo`) seeds through the real app
  functions: Northfield Aggregates branding and logo (`src/server/demo/northfield-logo.svg` → PNG),
  presenter shown as the fictional **Daniel Mitchell** inside demo companies only (their real account
  name is never changed), 8 customers, 7 trucks (106 out of service), 6 drivers on their primary
  trucks, 5 staff, confidential pay, two weeks of delivery history. Migration
  `20261031000200_driver_home_own_tickets.sql`: My Day lists tickets for the driver's own loads only.
  Reset = start a fresh demo (the previous one is deactivated, never deleted).
- **Avatars:** 20 original illustrated trucking/aggregate professionals (`public/avatars`, made by
  `scripts/generate-avatars.mjs`). People can choose one on `/profile` instead of uploading a photo
  (saved through the normal photo checks); employee records get one via migration
  `20261031000300_employee_avatars.sql` (for people without a login). Demo people each have one.
  Real photos / AI portraits: the session's network blocks stock-photo hosts.
- **Hosted migrations still to apply, in order:** `20261030000100`, `20261031000100`, `20261031000200`,
  `20261031000300` (back up first; DEPLOYMENT §2a).
- **Known flaky locally:** `tests/db/command-center.test.ts` first test runs ~19 s against the large
  local test database and can hit the 20 s timeout in a full run; passes alone.

## 1. Repository state (verified)

- **Branch:** `claude/top-line-trucking-manager-vmw04i`. This is the only development branch, and Vercel
  deploys the staging site from it. Run `git log --oneline -5` to see the current head.
- **Migrations:** 26 in `supabase/migrations/`, the latest being `20261028000100_demo_lead_workflow.sql` (demo-request workflow).
  Never edit an applied migration; add new ones.
- **Lint, typecheck and build:** clean at handoff.

## 2. Milestones

| Milestone | Delivered | Plan section |
| --- | --- | --- |
| N9 | Accounts, company onboarding, sign-up access codes, company switcher. | §5i |
| N10 | Unified Command Center, urgent orders, personal layout, ticket review queue, order progress. | §5j |
| N11 | Office scans, review context, bulk accept, delivered-so-far, `verified_delivery_inputs`. | §5k |
| N12 | Early Access page and server-enforced gate, operator script, deployment checker, `docs/DEPLOYMENT.md`. | §5l |
| N13 | See the breakdown below this table. | §5m |
| N14 | "Needs scheduling" queue (Dispatch and Command Center) for confirmed orders without a date; invoice draft from verified deliveries; measured Reports page. | §5n |
| N15 | Smart Dispatch (proposals with reasons and alternatives; approval re-checked; rejections audited); safety-report and capacity blocks in assignments; quote acceptance creates the order; delivery location required to schedule; fulfillment-based billing readiness; date-entry fix; company branding; website capability registry and release checklist. | §5o |

N13 delivered:
- **Public website:** 9 pages, five-tier pricing, a 3D hero built from real screens, and lead forms.
- **Platform owner role:** granted by an operator only, and audited.
- **`/admin` launchpad and lead workspace.**
- **Live demo company:** role previews, with nothing sent outside Taviron.
- **Team-led CSV onboarding:** review, approval and reversal.

## 3. Test results (run in this session's sandbox, N15)

| Check | Result |
| --- | --- |
| vitest: unit, DB and storage | 350/350 (45 files) |
| Browser suite, dev server | 55 passed, 5 skipped. The skipped tests are the gate spec, which runs separately below. |
| Gate spec against a production build with the gate on | 5/5 |
| Outside-in checker against that build | All checks passed |
| Lint, typecheck, production build | Clean |

**Migrations:** the two N15 migrations were applied to a second database that already held the 23 earlier ones.
- Its schema is identical to dev.
- DB tests there: 167 passed, 7 skipped (the skipped tests need the storage server).

**Test fixes made along the way** (not product changes): three older browser tests assumed shared queues were nearly
empty or used loose locators that also matched the new Smart Dispatch panel; they now scope to their own records.

**None of this ran against the live site.** The sandbox's network policy blocks `*.vercel.app`.

## 4. Deployment and Supabase status

**Verified from GitHub's deployment records** (the public GitHub API; Vercel reports each deploy there):
- Every push to this branch is deployed by Vercel to the project's **Production** environment.
- Commit `867db9e` (N14) deployed with state `success` (2026-10-11), deployment URL `https://tltmaster-feu4o4jpb-taviron.vercel.app`. Earlier: `a652bbb` (N13) and `5d06ca1` (docs).
- Vercel team `taviron`, project `tltmaster`.
- There are no Preview deployments.

`tltmaster.vercel.app` is that project's Production alias. A Production variable such as `PUBLIC_SITE` affects it, and would also affect
any custom domain added to the project later (none is known).

**What this sandbox cannot do:**
- Reach `*.vercel.app`: the network policy refuses the connection.
- Read Vercel settings, environment variables or domains.
- Reach the staging Supabase project: no credentials are present, by design.

| Item | Status |
| --- | --- |
| **Migrations through `20261028000100`** | **Applied to staging 2026-10-11 by the owner** (`migration list`: local = remote). Earlier note follows. No credentials here; it is the owner's action, in DEPLOYMENT §2a (which also says what the app does until they are applied). |
| What staging does until the migration is applied | The app keeps working. The demo/contact form says it cannot save. `/admin` answers 404. This comes from reading the code; it was not observed live. |
| `PUBLIC_SITE` | Not set as far as known, so the website is behind the gate. Devices admitted with a site code, and signed-in users, still see every page; this was verified locally on a production build of `a652bbb`. |
| `SITE_INDEXING` | Not set as far as known, so nothing is indexed. |
| `SITE_ACCESS_SECRET` | **Must be rotated.** An earlier value appeared in a screenshot. |
| Site code, company, owner login, phone sign-in, platform role | Not yet confirmed. |
| Auth URLs, templates, SMTP, `ticket-photos` bucket, backups | Not confirmed. See DEPLOYMENT §1. |

## 5. Outstanding manual actions (owner)

1. **Back up the staging database, then apply the new migrations (N13, N14 and N15).** Follow DEPLOYMENT §2a step by step: confirm the linked project, back up,
   run `db push --dry-run`, run `db push`, then confirm with `migration list`.
2. **Rotate `SITE_ACCESS_SECRET`** in Vercel, then redeploy.
3. **Run the outside-in check.** Expect every check to pass:
   ```bash
   node scripts/check-deployment.mjs https://tltmaster.vercel.app
   ```
4. **Create your access and account:** a site code, a company and an owner login (DEPLOYMENT §3), then sign in from your phone.
5. **Grant yourself the platform role**, then open `/admin` and start the live demo (DEPLOYMENT §3a):
   ```bash
   node --env-file=.env.staging scripts/platform-admin.mjs grant <your email> --note "Founder"
   ```
6. **When ready to show the public website:** get the Privacy and Terms drafts reviewed (pricing is in place). Then set
   `PUBLIC_SITE=on` in Vercel and redeploy. Set `SITE_INDEXING=on` only for the real launch domain.
7. **Supabase Auth setup:** URL configuration, email templates and SMTP (DEPLOYMENT §1).
9. **Domains:** in Vercel → Project → Settings → Domains, confirm where `mytaviron.com` is attached. If it is on this
   project, decide whether it should serve the current (gated) build now; a separate project or a Preview-branch setup
   is needed for a real preview/production split. Add the domain to Supabase → Authentication → URL Configuration.
8. **Shared Early Access password (DEPLOYMENT §3b):** back up staging, apply migration
   `20261029000100_shared_early_access_password.sql` (§2a), then add `EARLY_ACCESS_PASSWORD` (Sensitive) in Vercel and
   redeploy. Until both are done the shared password does not work — "not valid" without the variable, "temporarily
   unavailable" without the migration — and no access is granted; personal codes keep working. If a custom domain is attached, add it to Supabase → Authentication → URL Configuration → Redirect URLs.

10. **AI (optional, when you decide):** follow docs/AI.md §12 — hosted migration `20261110000100_ai_usage.sql`, a passing
   live evaluation for your chosen model, then the AI variables in Vercel. Until then AI stays Blocked and nothing is
   sent to OpenAI.

## 6. Known issues and decisions pending

- **N15 rules implemented but awaiting the business's confirmation** (TAVIRON_MASTER_PLAN §3): breakdown/inspection reports block a
  truck, equipment issues only warn; capacity overruns are refused; scheduling needs a delivery location; the fulfillment definition.
- **Smart Dispatch limits:** no truck locations (no distance or drive time), no driver availability or hours data, no trailer
  selection. It proposes only; it never assigns on its own.
- **Unticketed lines** (e.g. hauling with no ticket of its own): the invoice draft still uses the ordered quantity and flags it
  "confirm". Whether to bill ordered or delivered quantity is the business's decision.
- **Branding:** dialogs and toasts keep the default red; quote PDFs and the public website do not use company branding.
- **Local test database growth:** earlier e2e runs leave records (nothing is deleted). Tests that read shared queues now search or
  page for their own records.

- **Pricing:** the founder's five tiers are on `/pricing` (behind the gate). Founding-customer discounts are private and not shown.
  No billing or checkout code exists, and none may be added without explicit authorization.
- **Privacy and Terms** are drafts, marked on the page.
- **Imports are CSV only.** XLSX is not supported, and the uploader tells you to save as CSV.
- **No lead email notifications:** check `/admin/leads`.
- **The demo company keeps old demos.** Each "Reset" deactivates the old demo company and keeps it; nothing is deleted. Old demos are
  harmless, and a cleanup tool is planned.
- **The sandbox cannot reach the live site.** Add `tltmaster.vercel.app` to the cloud environment's allowed domains so a session can
  verify it.
- **Unreviewed `npm audit` findings:** 5 high-severity advisories on the owner's Mac. Do not run `npm audit fix --force`.
- **Hosting plans:** Vercel Hobby is non-commercial only, and Supabase Free has no backups. Upgrading is the owner's decision.
- **Product name:** "Taviron" is a working name, not cleared.

## 7. Next recommended task

**Website showcase + screenshots (2026-10-11):** homepage product showcase with an original dump-truck
illustration; all product screenshots recaptured from the new UI (IMPLEMENTATION_PLAN §5s).

**Smart Load Build increment 2 — travel-time approach decided (2026-10-11):** dispatcher-entered times first, no
routing service (SMART_LOAD_BUILD.md §10). Proposed tables `sources`, `route_times`, `site_unload_times` in
`docs/proposals/route_times.sql` — NOT in `supabase/migrations/` (so the pending `db push` for the Early Access fix
cannot apply it); tested on a scratch copy only. Next decision: is the loading source chosen per order, per material
or per load (§9.7-2)? Open item: the founder mentioned "six synchronized Smart Dispatch views" — no definition exists in
the docs or code yet; ask the founder for the list before recording it.

**Smart Load Build increment 2 — prepared (2026-10-11):** audit, data model proposal, staged plan and decisions in
docs/SMART_LOAD_BUILD.md §9. Implemented only pure trip/cycle-time logic (`src/lib/dispatch/trip-plan.ts`, 10 unit
tests), not wired to any page — no behaviour change, no migration, not deployed. Next decision: where trip times come
from (§9.7 question 1).

**Status check (2026-10-11, later session):** verified — Preview branch `claude/ui-and-signin-checkpoint` at `aadf07d`
(clean, equal to origin; Vercel Preview success); production branch at `16fc188`, still the only Production build
(16:07 UTC, no later Production record). Migration `20261029000100` on the Production Supabase project: **not
checked** — this sandbox has no linked project, no remote credentials, and the Supabase API is blocked, so which project
Production uses cannot be confirmed here. Early Access logs record only fixed text and error codes (never the
password, its value or the visitor's input). Smart Load Build open decisions (trip/cycle-time data, firm vs flexible
dates, driver-hour rules, mixed-material loads, alternative quarries, shared trips, cost) are in
docs/SMART_LOAD_BUILD.md §3 and §8. Employee Management requirements are recorded in the master plan (not started).

**Shared Early Access password refused on mytaviron.com (2026-10-11) — diagnosis:** Production still runs the single
build of `16fc188` from 2026-10-11 16:07 UTC (GitHub deployment records). The owner set `EARLY_ACCESS_PASSWORD` in
Vercel after that; Vercel applies variable changes only to deployments built afterwards, so the running deployment has
no shared password and treats the entry as a personal code → "That password isn't valid" (reproduced earlier by the
gate test without the variable). Other possibilities (less likely): the value differs from what is typed (exact,
case-sensitive), or it is under 12 characters. Owner actions (Production — need explicit approval): (1) check that
migration `20261029000100` is applied on the Supabase project Production uses (`npx supabase migration list`), and
apply it after a backup if not — otherwise a correct password shows "temporarily unavailable"; (2) Vercel →
Deployments → the current Production deployment → ⋯ → **Redeploy** (same commit, picks up the variable). The Preview
branch now logs "EARLY_ACCESS_PASSWORD is not set on this deployment" when that is the case (never the value).

**Smart Load Build increment 1 (2026-10-11):** `/orders/[id]/load-build` — see docs/SMART_LOAD_BUILD.md. Engine
`src/lib/dispatch/load-build.ts`, loader `src/server/data/load-build.ts`, approval action next to the page. No
migration. Tested locally (unit + browser); on the Preview branch.

**Checkpoint backup and Preview path (2026-10-11):** with the owner's approval, commits `e692c05`, `428fd4f`,
`8e49dab`, `7586464` were pushed to the new branch `claude/ui-and-signin-checkpoint` (the production branch
`claude/top-line-trucking-manager-vmw04i` stays at `16fc188`). Vercel recorded it as **Preview** (success,
`tltmaster-ck789m9xh-taviron.vercel.app`); Production untouched. Further work goes on that branch (CLAUDE.md policy).
Preview's environment variables are unknown — the preview may answer 503 until they are set (DEPLOYMENT §2b step 4).

**Sign-in fails on mytaviron.com but works on tltmaster.vercel.app (owner report, 2026-10-11) — not yet resolved:**
- Both run code where "Email or password is incorrect." means Supabase answered 400 (wrong password, unconfirmed
  email, or no such user in the project asked). A password sign-in is a server-to-Supabase call; it does not depend
  on the website's domain. So if both domains used the same Vercel deployment and variables, the same credentials
  would behave the same way. Something differs; the candidates, most likely first:
  1. **A different password is sent** — browsers keep saved passwords per site, so `mytaviron.com` may autofill an
     old or different one (e.g. the Early Access password). Check: type the password by hand there.
  2. **`mytaviron.com` uses another Supabase project** — it is attached to a different Vercel project or environment
     whose `NEXT_PUBLIC_SUPABASE_URL` differs (the account would not exist there). Check: Vercel → Project
     `tltmaster` → Settings → Domains (is it listed, on which environment/branch?), and compare
     `NEXT_PUBLIC_SUPABASE_URL` per environment (a public value).
  3. **Auth logs:** Supabase (taviron-staging) → Logs → Auth, at the time of the failed attempt: an
     `invalid_credentials` / `email_not_confirmed` entry means the right project with a wrong password / unconfirmed
     email; no entry means the request went to another project.
- Claude could not check any of this: the sandbox's network policy blocks both domains and the Vercel/Supabase APIs.
- Code side: `8e49dab` names unconfirmed emails; the backup branch also logs the error code (never the email or
  password) on every refused sign-in, so once that code serves a domain, Vercel's runtime logs show which case it is.

**Sign-in and platform access (2026-10-11, local only, not pushed):** two defects fixed and tested locally. (1) With the
right password on an account whose email was never confirmed, Supabase answers `email_not_confirmed` (it checks the
password first), but the page said "Email or password is incorrect." It now says the email is unconfirmed; wrong passwords
keep the generic message. Likely cause for an owner whose sign-up confirmation email never arrived (no SMTP yet). (2) A
platform owner working inside a company had no in-app way to `/admin` (only the demo bar linked there); the user menu now
shows "Platform administration" when the server confirms the role, and `/admin` still checks it. Not verified on staging:
whether the owner's account exists, is confirmed and holds the platform role is visible only in Supabase (owner action).

**Internal UI checkpoint 2 (local only, not pushed):** Dispatch — "Needs scheduling" is a bounded, scrollable panel with
tighter rows, so the board and Smart Dispatch are on the first screen (every order still listed). Billing — the "Why · what
to do" column is now "Reason" plus a short "Next step" link to the order (the full explanation stays on the order's page),
and the reason no longer repeats "still to run". Checked at 1440 and 390 px, light and dark.

**Internal UI checkpoint 1 (local only, not pushed):** shared shell and Command Center refinements — sidebar grouped
under Sales / Operations / Finance / Company headings (same links and permissions), page descriptions capped at a
readable width so page actions sit beside the title, a quiet outlined SAMPLE badge, a secondary-weight Apply in filter
bars, press feedback on buttons (none with reduced motion), and Command Center section labels as small group headings
above the cards, with "Arrange sections" on the first section's line. No data, logic, permissions or routes changed.
Next candidates: Billing's long "why" column, table density, Dispatch board header. Held back from pushing until the
preview/production split is verified (DEPLOYMENT §2b): today every push still deploys to Production.

**Preview vs production (2026-10-11):** verified from GitHub — one branch (the default), and all 19 Vercel deployments
are Production; there is no preview today, so every push reaches every domain on this project (`tltmaster.vercel.app`, and
`mytaviron.com` if attached here — unverified, Claude's network policy blocks both hosts and the Vercel/Supabase APIs). No code
change is needed for a split. Proposed setup and promotion workflow: DEPLOYMENT §2b (owner approval needed; nothing changed yet).
Until the split is made, treat every push as a production deployment.

**Domains, sign-in logo and redirects (2026-10-11):**
- **Sign-in logo:** on the sign-in pages (login, sign-up, password reset) the Taviron logo now links to
  `https://mytaviron.com` in the same tab (`src/lib/site/urls.ts`); tested by mouse and keyboard. Other logos unchanged.
- **Open-redirect fix:** `safeNextPath` now refuses control characters; before, `?next=/%09/evil.example` sent a user to
  another site after sign-in (confirmed by a test against the old code). Fixed and tested.
- **Domains — not verified:** this session's network policy blocks `mytaviron.com`, `tltmaster.vercel.app`, public DNS and
  the Vercel/Supabase APIs, so DNS, HTTPS and domain assignment are unconfirmed. GitHub's deployment records show every
  push deploying to Vercel's **Production** environment (the one `tltmaster.vercel.app` serves). If `mytaviron.com` is
  attached to this same project, it serves the same build, variables and Supabase project — there is no separate
  preview today. The gate keeps both private. No canonical URLs, sitemap or hardcoded preview address exist; absolute
  links come only from `APP_BASE_URL` (per Vercel environment).
- **Shared password:** the owner has chosen it (not recorded anywhere in the repository). It works only after the
  staging migration `20261029000100` is applied and `EARLY_ACCESS_PASSWORD` is set in the Vercel environment that
  serves the address in use, then redeployed. Not verified live.

**Shared Early Access password (2026-10-11):** the Early Access page is now a branded Taviron page
(`src/app/early-access/`) that accepts one shared password from the server environment as well as personal site
codes; each entry still gets its own revocable device grant, and sign-in, roles and RLS are unchanged
(IMPLEMENTATION_PLAN §5v). Tested locally against a gated production build. Staging needs the owner's migration and
environment variable (§5 item 8); the live flow has not been verified.

**Pricing and light/dark mode (2026-10-11):** `/pricing` shows the founder's five tiers (founding discount stays
private; IMPLEMENTATION_PLAN §5t). The app has an Appearance choice in the user menu — Light, Dark, Match my device —
stored per browser (§5u). Both are behind the Early Access gate like the rest of the site.

**App overhaul Phase 1 (2026-10-11):** shell + Command Center restyled, urgency colour fixed, presentation mode
for clean screenshots (IMPLEMENTATION_PLAN §5r, `docs/SCREENSHOTS.md`). The public-page redesign is paused until
the app modules are done; next app module per the founder's review.

**Website redesign Phase 1 (2026-10-11):** the homepage is redesigned on the Taviron palette (IMPLEMENTATION_PLAN
§5q). Phase 2 = the other public pages (Platform, Solutions, Pricing — pricing content waits for the founder's
approval —, About, Demo, Contact, legal).

**Staging update, 2026-10-11 (owner, on their Mac):** backup made with the Supabase CLI (schema 563 KB, data
298 KB, in the owner's Documents folder — the first `pg_dump` attempt produced a 0-byte file and was discarded);
`npx supabase db push` applied the five pending migrations (`20261025000100` … `20261028000100`) to the linked
project taviron-staging with no errors; `migration list` shows all migrations local = remote. The owner then ran
the read-only SQL check and the five-step demo check (DEPLOYMENT §2a) on `tltmaster.vercel.app` and reported all
of it working. These results were observed by the owner, not by a Claude session.

**Earlier the same day (session view):** the code (`6177920`) is deployed — GitHub's deployment
record for that commit says `success` (Vercel Production, aliased to `tltmaster.vercel.app`). Nothing was verified
*on* staging: this session's network policy refuses `*.vercel.app`, `api.supabase.com` and `api.vercel.com`, there
are no Supabase/Vercel credentials, and no staging backup exists here. The owner applies the migrations
(DEPLOYMENT §2a, with `scripts/staging-check.sql` before and after) and runs the five-step demo check there; or
adds `tltmaster.vercel.app` to the environment's allowed domains so a session can check the website side.


**2026-10-11 consolidation:** `docs/TAVIRON_MASTER_PLAN.md` now holds the founder's full master context (status by
area, branding palette, pricing proposal, demo-lead requirements, Outstanding Fixes and Operational Risks §8,
open decisions §9, roadmap order §11). Design skills from `emilkowalski/skills` are installed in `.claude/skills/`.
The first item on the roadmap is website and demo readiness (master plan §11.1). The demo-request flow is done
locally (IMPLEMENTATION_PLAN §5p); next come the reminders (§8 W6) and the pricing page (§8 W1), each after the
founder reviews the previous step.


Finish B3 staging, which now includes N13, N14 and N15 (section 5 above), then answer the open questions in TAVIRON_MASTER_PLAN §4. After that:
1. The first real team-led onboarding.
2. Payroll readiness, once pay rules are written down.
3. Company billing requirements.
4. Fleet maintenance.

See IMPLEMENTATION_PLAN "Recommended next task".

## 8. Instructions for a fresh Claude Code session

1. **Read the docs:**
   - This file.
   - `docs/IMPLEMENTATION_PLAN.md` (§5i–§5m, "Recommended next task", §8).
   - `docs/DEPLOYMENT.md`, `docs/ARCHITECTURE.md` and `AGENTS.md`.
   - The Next.js docs in `node_modules/next/dist/docs/`, before writing any Next.js code.
2. **Check the repository:** run `git status` and `git log --oneline -5`, and confirm the branch matches `origin`. Do not redo milestones N9–N15.
3. **Rules that stay in force:**
   - Never reset or delete data, edit applied migrations, deploy to production, buy services or change DNS without approval.
   - Never print or commit secrets, and never ask the owner to paste keys or codes.
   - Preserve RLS, server-side checks and tenant isolation. The platform role grants no company data except through audited platform functions.
   - Fictional data only. No invented contacts, testimonials or customers.
   - Back up a dev database before schema changes.
   - Commit messages end with the session's co-author trailer.
   - Push only to this branch, and open no PR unless asked.
4. **Local stack:** rebuild it per `docs/SETUP.md` §6. Postgres data lives in `/var/lib/tlt-pg/data` on port 54322: start it with
   `pg_ctl`, then run `scripts/dev-stack/stack.sh up`. Start Next with `npx next dev -p 3000`.
