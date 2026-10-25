# AI runtime foundation

How Taviron calls AI models: the provider-independent interface, the OpenAI adapter, configuration, readiness gates,
evaluations, usage and budgets, tools and approvals. Master plan §12 B6. First built 2026-10-13.

**Status:** see §16 for Ask Taviron's current state (2026-10-24).
- Code: written, tested with mocked provider responses.
- Usage-ledger migration `20261110000100_ai_usage.sql`: applied to the local database only. The hosted database needs
  the owner's approval (DEPLOYMENT §2a).
- Real OpenAI calls: never made from this repository's tests. No evaluation evidence has been recorded, so every
  capability is **Blocked** until the owner configures it, and then **Needs review** until a live evaluation passes.

## 1. What exists

| Piece | File |
| --- | --- |
| Provider-independent types, errors and the `AiProvider` interface | `src/server/ai/types.ts` |
| OpenAI adapter (official `openai` SDK, Responses API; SDK retries and logging off) | `src/server/ai/openai.ts` |
| Configuration (server only) | `src/server/ai/config.ts` |
| Capabilities and readiness gates (pure) | `src/lib/ai/capabilities.ts` |
| Recorded evaluation evidence (empty) | `src/lib/ai/evidence.ts` |
| Tool registry: read / propose / execute, approval | `src/server/ai/tools.ts` |
| Orchestrator: gate, budget, rate limit, tool loop, validation, usage, fallback | `src/server/ai/run.ts` |
| Server wiring: provider, session ledger, gates | `src/server/ai/gates.ts` |
| First capability, "Explain this plan" | `src/lib/ai/plan-explanation.ts`, `src/server/ai/plan-explanation.ts`, `explainPlan` in `src/app/(app)/dispatch/plan/actions.ts`, `src/components/dispatch/plan-explanation.tsx` |
| Evaluation runner, and the opt-in live run | `src/server/ai/evals.ts`, `tests/live/ai-eval.live.test.ts` (`npm run ai:eval`) |
| Usage ledger | `supabase/migrations/20261110000100_ai_usage.sql` (rollback in `supabase/rollbacks/`) |
| Per-person limits and the platform pause switch | `supabase/migrations/20261120002400_ai_usage_limits.sql` (`public.ai_usage_limits()`, `private.ai_controls`; rollback in `supabase/rollbacks/`) |
| Status per capability | Company setup (`/setup`), "AI capabilities" section |

Ask Taviron (§15) is the second capability. Nothing else in the product calls a model. Smart Dispatch and Plan the day stay deterministic. The AI explanation
is an optional layer on top of the plan and never changes it.

## 2. Request flow

Every request follows these steps:

1. **Permission.** The server action checks the person's permission from their session (`assertPermission`).
2. **Recompute on the server.** The server recomputes the data the request is about. Numbers sent by the browser are
   never trusted.
3. **Readiness gate** (§4). Only Ready or Limited may continue.
4. **Ledger, limits and budget** (§6). If the ledger or the per-person limits cannot be read, nothing is sent. Nothing
   is sent either while the platform owner's pause switch is on, when the person's per-minute, daily or monthly limit
   or the company's per-minute, monthly token or estimated cost limit is reached, or when the request is larger than
   `AI_MAX_REQUEST_CHARS`.
5. **Sensitive-data check** (§10). Real names, email addresses and record ids found in the outgoing request stop it
   before it is sent.
6. **Provider call** (at most 3 rounds). Tool calls between rounds go through the registry (§8). Every call is recorded
   in the ledger, whether it succeeds or fails.
7. **Validation.** The final answer must be JSON in the capability's schema and pass its checks. For "Explain this
   plan" these are grounding, references, forbidden claims and leaks.
8. **Result.** Real labels are put back on the server and the answer is shown, labelled as AI-generated, with the
   model, the reported tokens and the estimated cost.

Application code depends only on `AiProvider`. A second provider would be one more adapter, with its own tests and
its own evaluation evidence (evidence is kept per provider and model).

## 3. Configuration

Server-side environment variables only. None is `NEXT_PUBLIC_`, and none is ever sent to the browser. Malformed values
are ignored, and only their *names* appear on the setup page.

| Variable | Meaning |
| --- | --- |
| `AI_PROVIDER` | `openai` (the only adapter). Unset means no AI. |
| `OPENAI_API_KEY` | Secret. Set it in Vercel's environment settings (owner action), never in the repository. Format `sk-…`. |
| `AI_CAPABILITIES` | Comma-separated capabilities to switch on, for example `plan_explanation`. **A key alone switches nothing on.** |
| `AI_MODEL_PLAN_EXPLANATION` | The model id for this capability. No model is hard-coded. Choose one that supports structured outputs on the Responses API. |
| `AI_FALLBACK_MODEL_PLAN_EXPLANATION` | Optional approved fallback. It is used only when it has its own passing evaluation evidence. |
| `AI_MONTHLY_TOKEN_LIMIT` | Required. Reported input plus output tokens per company per calendar month (UTC). |
| `AI_REQUESTS_PER_MINUTE` | Per company, default 6. |
| `AI_TIMEOUT_MS` | Per provider call, default 20000 (allowed range 2000–60000). |
| `AI_PRICING_JSON` | Optional prices, `{"<model>": {"inputPerMillion": n, "outputPerMillion": n}}` in USD per million tokens, entered from the provider's price list. Without it, costs are not estimated and the gate is Limited. |
| `AI_IN_DEMOS` | `on` lets demo companies call the model (default off; see §11). |
| `AI_COMPANY_ALLOWLIST` | **Customer activation.** Comma-separated company ids (UUIDs) of real companies allowed to use AI. Unset or empty: no real company can (fail closed). Demo companies follow `AI_IN_DEMOS` instead. |
| `AI_USER_MONTHLY_TOKEN_LIMIT` | Required. Reported tokens per person per calendar month (UTC). Without it every capability is Blocked. |
| `AI_USER_REQUESTS_PER_MINUTE` | Model calls per person per minute, default 6 (one question makes up to 3 calls). |
| `AI_USER_DAILY_REQUESTS` | Model calls per person per UTC day, default 150. |
| `AI_MONTHLY_COST_LIMIT_USD` | Optional estimated cost ceiling per company per month, from `AI_PRICING_JSON`. When set, a model without a price is Blocked (the ceiling could not be enforced). Unset: no cost ceiling (the token limits still apply). |
| `AI_MAX_REQUEST_CHARS` | Largest request sent to the provider (instructions, question, context and tool results), default 40000 characters. |

**Reasoning models** (`gpt-5…`, `o…`): they spend hidden reasoning tokens that count against the output cap. The
adapter sends `reasoning: { effort: "low" }` and adds a fixed allowance (`REASONING_ALLOWANCE`, `src/lib/ai/reasoning.ts`)
to each capability's answer budget; the token-budget checks use the same cap. Found by the first live evaluation
(gpt-5-mini, 2026-10-23): every answer was cut off at `max_output_tokens`.

## 4. Readiness gates

`evaluateGate` (pure) decides one of four states per capability and person. The same function serves the server and
the setup page.

| State | Meaning | When |
| --- | --- | --- |
| **Blocked** | Never calls a model | Any of: no permission, no provider or key, malformed AI settings, capability not switched on, no model, provider lacks structured output, no monthly token limit (company or per person), usage ledger or per-person limits unavailable (migration `20261120002400` not applied), platform pause switch on, demo company without `AI_IN_DEMOS=on`, real company not on `AI_COMPANY_ALLOWLIST`, company or personal monthly limit used up, cost limit reached or set for an unpriced model. |
| **Needs review** | Never calls a model | Configured, but the model's latest evaluation is missing, failing (pass rate under 90% or any critical failure), older than 90 days, or from an older test set. |
| **Limited** | Runs, with a stated limitation | No price for the model (cost not estimated), at least 80% of the monthly limit used, or a configured fallback without evidence (it will not be used). |
| **Ready** | Runs | Everything above is in place. |

## 5. Evaluations

- **Test set.** `EVAL_CASES` in `src/lib/ai/plan-explanation.ts` holds three fictional plans: one with partial coverage,
  urgent loads and a load without a rate; one with tractors and trailers; and one with an overdue load left open.
  `evalVersion` is bumped whenever the cases or checks change. Older evidence then no longer counts.
- **Grader.** `checkExplanation` checks the answer, the same as for live answers.
  - Critical checks:
    - schema;
    - invented numbers (every number must appear in the facts);
    - unknown codes;
    - forbidden claims ("optimal", "guaranteed", "verified", "compliant", profit, a margin estimate);
    - leaked names, email addresses or phone numbers.
  - Non-critical check: the hours-of-service caution is missing.
- **Running it (owner or operator, spends a few cents):**
  `OPENAI_API_KEY=… AI_MODEL_PLAN_EXPLANATION=<model> npm run ai:eval`. It prints each case and an evidence object.
  Only if it passed, copy the evidence into `src/lib/ai/evidence.ts` and commit it. Never write evidence by hand.
  The core suite never runs this: the `live` vitest project is empty unless `AI_LIVE_EVAL=1`.

## 6. Usage, budgets and cost

- **Ledger.** `public.ai_usage_events` gets one row per provider call. Each row holds:
  - company and user, both taken from the session by `public.record_ai_usage`;
  - capability, provider and model;
  - outcome and error kind;
  - **reported** input and output tokens (null when the provider did not report them, never estimated);
  - an **estimated** cost in micro-USD (null without a price);
  - latency.
- **What is never stored:** prompts, answers, names or any business content.
- **Rules:**
  - Rows are append-only.
  - Owners can read them through `settings.manage`.
  - Each request key is recorded only once.
- **Budget.** The monthly cap is checked before any call, against tokens already used plus a projection for this
  request. It is checked again before every round.
- **Rate limits.** Per company and per person, counted in the ledger over the last minute; per person also per UTC
  day. Counts are model calls.
- **Per-person budget.** `AI_USER_MONTHLY_TOKEN_LIMIT`, checked like the company budget, before the first call and
  before every round. A person who uses theirs up is Blocked for the rest of the month; the rest of the company is not.
- **Cost ceiling.** `AI_MONTHLY_COST_LIMIT_USD` stops new requests once the company's estimated cost this month reaches
  it. Estimates come only from the owner's `AI_PRICING_JSON`; no price is hard-coded. An unpriced model cannot run while
  a ceiling is set.
- **Size.** Requests over `AI_MAX_REQUEST_CHARS` are not sent; each capability also caps its output tokens.
- **Pause switch.** `private.ai_controls.paused` (§16) stops every request on every company at the next request.
- **Cost.** Shown as "estimated cost" and kept separate from reported tokens. It is null rather than guessed when no
  price is configured.
- **Known limits:**
  - Any member of a company can call `record_ai_usage`, so a member could inflate their own company's usage. That only
    uses up their company's AI budget sooner; it exposes nothing.
  - Simultaneous requests: fixed by `20261120002500`. Each model call is first reserved by `public.ai_reserve_call`,
    which takes a per-company advisory lock, recomputes the company's and the caller's usage **including calls still in
    flight** (their projected tokens), checks the pause switch and every limit, and refuses or reserves. Recording the call
    (`record_ai_usage`, same request key) replaces the projection with the reported tokens. A reservation left behind by a
    crashed request stops holding tokens after 15 minutes but still counts as a call. Without the migration nothing is
    reserved and nothing is sent. Proven with eight and six parallel connections in `tests/db/ai-usage-concurrency.test.ts`
    and with interleaved requests in `tests/unit/ai-assistant-security.test.ts`.

## 7. "Explain this plan" (first capability)

- **Where:** Plan the day (`/dispatch/plan`) has an "Explain this plan" section for the selected plan.
- **Who:** permission `dispatch.view`. Tools: read and propose only.
- **Facts.** `buildPlanFacts` produces pseudonymous facts:
  - Codes replace names: `L1` load, `C1` customer, `S1` site, `T1` truck, `R1` trailer, `D1` driver.
  - Free-text reasons are rewritten with the codes, longest label first.
  - Ids, order numbers, unit numbers, names and addresses stay on the server.
- **Answer:** `{summary, highlights[≤4], checks[≤4], loadsToReview[]}` in strict JSON. It must pass every check in §5.
  Any failure means the AI explanation is unavailable and the plan is unchanged.
- **Display.** Codes are mapped back to real labels on the server. The answer is labelled "AI-generated summary ·
  checked against Taviron's figures · it does not change the plan". Below it are the model, the reported tokens and
  the estimated cost.
- **Suggested priorities.** A `propose_priorities` result appears as a "Try them (nothing is assigned)" link. It only
  re-plans with those weights.

## 8. Tools and approvals

- **Registry entries.** Each tool has a name, a description, a kind (`read` / `propose` / `execute`), a permission, a
  strict JSON schema for the provider, and a zod schema used on the server.
- **Checks before a tool runs.** Model arguments are untrusted. A tool call must pass all of these:
  - the tool is registered;
  - its arguments are valid JSON and validate;
  - the person holds the tool's permission (from the session);
  - the capability's ceiling (`maxToolKind`) allows the tool's kind.
- **Refusals.** A refused call returns an error to the model, and nothing runs. Three refusals end the request.
- **Company scope.** Company ids are never tool arguments. Tools resolve only data the server prepared for the
  caller's company. For example, `get_load_details` takes a plan code (`L3`), not an id, so another company's load
  cannot be named.
- **`execute` tools.** They never run in the model loop. They become pending approvals, and
  `executeApprovedTool` runs one only for an approver who holds its permission, with arguments re-validated. **No
  execute tool is registered.** Consequential AI actions (assigning, sending, paying, exporting) are not enabled, and
  each would need its own explicit authorization.

## 9. Failures, retries and fallback

| Error kind | Retried by adapter | Fallback model |
| --- | --- | --- |
| `rate_limit` (429), `timeout`, `provider` (5xx, network, non-JSON) | once | yes, if an approved fallback has passing evidence |
| `auth` (401/403), `bad_request` (400/404/422) | no | no |
| `invalid_output` (schema, grounding, refusal, cut off), `tool`, `budget`, `disabled`, `not_configured`, `sensitive_data` | no | no |

Error messages never include the key, the request body, model arguments or the provider's own error text (which can
quote part of a key): the adapter maps each failure to a fixed message, and `publicMessage` (`src/server/ai/types.ts`)
gives people one fixed sentence per kind ("The AI service is not available right now. Nothing was changed.", "The AI
service is busy. Try again in a minute.", …). Limit messages are Taviron's own wording. Nothing in the AI path writes
prompts, answers or records to the console.

## 10. Privacy and sensitive data

- **Pseudonyms first** (§7).
- **Hard stop.** `findSensitive` blocks the request if any real label, email address or record id appears anywhere in
  it, including tool results. Nothing is sent.
- **Not stored at OpenAI.** Requests are sent with `store: false`, so OpenAI does not keep the response for later
  retrieval. OpenAI's own data-use and retention terms still apply. The owner should review them before switching a
  capability on.
- **Not stored by Taviron.** Prompts and answers are not stored; the ledger keeps counts only.

## 11. Demo companies

- **Default:** AI is Blocked in demo companies. The intentional difference is documented in DEMO_TENANTS §2: calling a
  model spends money and sends data to a third party, so that is the owner's choice.
- **What demos show:** the normal "AI explanations are not available" state on Plan the day and Company setup in every
  demo mode. The deterministic plan works exactly as everywhere else.
- **With `AI_IN_DEMOS=on`:** demos use the same gates, budget and checks as every company. No sample data is needed:
  the explanation uses the existing planning-day samples.

## 12. Turning on "Explain this plan" (owner actions, each needing approval)

1. **Apply the migration.** Apply `20261110000100_ai_usage.sql` to the hosted database (DEPLOYMENT §2a). Back it up
   first.
2. **Choose a model.** Pick a model, then run `npm run ai:eval` with a key. Commit the evidence only if it passed.
3. **Set the variables in Vercel.**
   - Required: `AI_PROVIDER=openai`, `OPENAI_API_KEY`, `AI_CAPABILITIES=plan_explanation`,
     `AI_MODEL_PLAN_EXPLANATION`, `AI_MONTHLY_TOKEN_LIMIT`.
   - Optional: `AI_PRICING_JSON`.
   - Set a spending limit on the OpenAI project as a second safeguard.
4. **Deploy and verify.** Deploy, open Company setup, and confirm the capability shows Ready or Limited. Then open Plan
   the day and verify one explanation.

## 13. Adding a capability

1. Add it to `AI_CAPABILITIES`, with its permission, tool ceiling, evaluation version and pass rate.
2. Add its configuration keys.
3. Define its facts, output schema and checks, plus fictional evaluation cases.
4. Register its tools and keep execute tools out unless explicitly authorized.
5. Write a server action that recomputes the facts on the server.
6. Write mocked tests (§14) and run a live evaluation.
7. Update this file, DEMO_TENANTS and the master plan.

## 14. Tests

- `tests/unit/ai-foundation.test.ts` covers, with mocked fetch and scripted providers:
  - configuration;
  - missing credentials;
  - every gate state;
  - the adapter: request shape, tool encoding, auth/429/5xx/400, timeout, malformed, incomplete, refusal and missing
    usage;
  - pseudonymization and the checks;
  - tools: unknown, malformed, invalid, permission, cross-tenant ids, the kind ceiling, execute versus approval;
  - the orchestrator: closed gate, ledger, rate limit, budget, sensitive data, invalid answers, round and refusal
    limits, fallback rules, refusal;
  - the evaluation runner.
- `tests/db/ai-usage.test.ts`: the ledger's company scope, read permission, append-only rule, idempotency and
  validation.
- `tests/db/ai-assistant-scope.test.ts`: the reads Ask Taviron makes (orders by id and reference, loads, fulfillment, the
  attention queue, trucks, the period report) as a person limited to one dispatch base and as another company's owner;
  the per-person usage summary (own and company totals, never another company's) and the pause switch (readable only
  through the summary, changed only by the database owner).
- `tests/unit/ai-assistant-security.test.ts` (mocked provider): cross-module summary, the period report's limits and
  totals-only output, another company's or base's reference, raw ids and unissued codes, role-based tools, prompt
  injection in customer names, notes and descriptions, answers that follow injected text, prohibited changes (assign,
  approve, permissions, SQL), missing configuration and the allowlist, provider errors and timeouts with fixed
  messages, per-person / company / cost / pause / size limits, cost tracking, and nothing written to the console.
- `tests/e2e/plan-the-day.spec.ts`: the Blocked state on Plan the day and Company setup in the presenter demo.
- `tests/unit/ai-assistant.test.ts` (Ask Taviron, mocked provider): what reaches the model (no names, references, ids or
  typed free text), relabelling and links, order lookups only from typed references, tool permissions per role, read-only
  tools, rejected invented figures / unknown codes / forbidden claims / leaks, provider failure, gates (switch, model,
  demo, evidence), and the evaluation runner. `tests/e2e/ai-assistant.spec.ts`: header entry, the Blocked state with and
  without configuration details, no entry or access for a driver, phone layout.

## 15. Ask Taviron (operational assistant, second capability)

**Status (2026-10-20):** code written and tested with a mocked provider (`tests/unit/ai-assistant.test.ts`, browser
`tests/e2e/ai-assistant.spec.ts`). **No real model call has been made**: no provider key exists in this environment, and
no evaluation evidence is recorded, so the capability is **Blocked** everywhere until the owner configures it (§12
steps, with the assistant's variables below), then **Needs review** until `npm run ai:eval` passes for its model.

- **Where:** `/assistant`, opened from the sparkle button in the app header. Shown to people with any of
  `orders.view`, `dispatch.view`, `maintenance.view`, `tickets.view`, `billing.view`; never to a driver-only login
  (the phone view stays free of distractions). While the gate is closed the page says why (reasons for people with
  `settings.manage`) and links to the Command Center, Dispatch, Maintenance and the Help Center; there is no question
  box that cannot answer.
- **Capability:** `ops_assistant` in `src/lib/ai/capabilities.ts`; tool ceiling **read**. It never assigns, sends,
  bills, approves or changes anything; asked to, it names the page where a person does it.
- **Tools** (`src/server/ai/assistant.ts`), each permission-checked on the server and offered only to people who may
  use it (`toolsFor`):

  | Tool | Permission | Reads |
  | --- | --- | --- |
  | `attention_queue` | any of orders/dispatch/tickets/billing/fleet view | the Command Center queue (`command_center_exceptions`, already permission-aware) |
  | `order_status` | `orders.view` | one order: status, requested date, loads by status, fulfillment, billing readiness (`billing.view` only) |
  | `maintenance_attention` | `maintenance.view` | open work orders and preventive maintenance overdue or due soon |
  | `week_outlook` | `dispatch.view` | the 7-day outlook (Taviron Live) |
  | `period_report` | any of tickets/billing/fleet/dispatch view | totals for up to 92 days from `report_operations` (security invoker, so row-level security and dispatch bases apply; each section only with its permission): tickets accepted/waiting/voided/corrected, the value of accepted tickets, billing handoff and loads without tickets, truck utilization. Totals only: the report's ranked lists (customer names, unit numbers) are not sent. |
  | `help_search` | any of the assistant's permissions | Help Center articles the person may read |

  Data is read with the person's own session (`src/server/data/assistant.ts`), so row-level security decides what is
  visible. `order_status` resolves only an order reference the person typed or an order already shown in this answer:
  a model cannot probe other records.
- **Privacy and injection:** the question's references (ORD-1042, ord1042…) and the names of customers and employees the
  person can see become codes; email addresses and phone numbers are removed. Tool results carry codes, catalog labels,
  dates and counts only. Free text people typed into records (urgency notes, driver report descriptions, work order
  titles) is never sent: it can carry names or instructions aimed at the model. The instructions also say tool results
  are data, never instructions.
- **Checks** (`checkAnswer` in `src/lib/ai/assistant.ts`): schema; every number must appear in what the model was given
  (0 and 1 allowed as words); every code must be one the server issued in this request; forbidden claims (optimal,
  guaranteed, verified, compliant, profit, margin); no real names, references, email addresses or phone numbers. Any
  failure means no answer is shown. Passing answers get real labels and links back on the server and are labelled
  "AI-generated … checked against them … it changes nothing", with the model, tokens and estimated cost.
- **Honest limits written into the instructions:** Taviron does not issue invoices or record payments (questions about
  overdue invoices answer *no data*); hours of service are not tracked; Smart Dispatch decides eligibility.
- **Not yet:** multi-turn conversation (each question stands alone), CRM summaries and drafted follow-ups, contextual
  entry points on individual pages, per-customer or per-truck breakdowns in reports (they would need pseudonymized
  ranked lists).
- **Configuration:** `AI_CAPABILITIES` must include `ops_assistant`; `AI_MODEL_OPS_ASSISTANT` (and optionally
  `AI_FALLBACK_MODEL_OPS_ASSISTANT`); the shared `AI_PROVIDER`, `OPENAI_API_KEY`, `AI_MONTHLY_TOKEN_LIMIT`,
  `AI_REQUESTS_PER_MINUTE`, `AI_TIMEOUT_MS`, `AI_PRICING_JSON`, `AI_IN_DEMOS`. Then
  `OPENAI_API_KEY=… AI_MODEL_OPS_ASSISTANT=<model> npm run ai:eval` and commit the printed evidence only if it passed.
- **Demo companies:** same page and code; Blocked unless `AI_IN_DEMOS=on` (DEMO_TENANTS §2, existing difference), so a
  demo shows the honest "not available" state. When allowed, it reads the demo's own sample records.

## 16. Ask Taviron activation, evaluation and immediate disable (2026-10-24)

**Update 2026-10-25:** evaluation version 3 passed on `gpt-5-mini` (6/6, no critical failure; GitHub Actions run
40225336674 via the manual `AI evaluation (manual, paid)` workflow), and the evidence is recorded in
`src/lib/ai/evidence.ts`. The privacy notice and terms now describe the optional AI features and list OpenAI
(published as drafts, subject to change), and Ask Taviron shows the OpenAI notice under the question box. The owner
reports the Vercel variables are set. Real companies still need to be listed in `AI_COMPANY_ALLOWLIST`.

**Status:** code written and tested locally with mocked providers (no paid call). Migration `20261120002400` is applied
to the local database only. Evaluation version 3 (period report and injection cases) has **no evidence yet**, so Ask
Taviron is **Needs review** everywhere until a new `npm run ai:eval` passes, and **Blocked** for every real company until
it is listed in `AI_COMPANY_ALLOWLIST`. Nothing is activated for customers by this change.

**Authorization before retrieval.** The server checks the person's permission from the session (`askAssistant`), offers
only the tools their role allows (`toolsFor`), and every tool reads through the person's own Supabase session
(`src/server/data/assistant.ts`): row-level security limits rows to their company and dispatch bases before anything is
read, and `report_operations` runs as the caller. Tools take codes issued in this request or a reference the person
typed, never ids, company ids or base ids. Nothing unauthorized is fetched and then hidden from the model.

**Activation prerequisites (owner, each needing approval):**
1. Back up and apply `20261120002400_ai_usage_limits.sql` to the hosted database (after `20261110000100`; DEPLOYMENT §2a).
2. Run the evaluation with synthetic data: `OPENAI_API_KEY=… AI_MODEL_OPS_ASSISTANT=<model> npm run ai:eval` (spends a
   few cents; never part of CI). Commit the printed evidence only if every case passed with no critical failure.
3. In Vercel (server-side variables): `AI_PROVIDER=openai`, `OPENAI_API_KEY`, `AI_CAPABILITIES=ops_assistant` (plus
   `plan_explanation` if wanted), `AI_MODEL_OPS_ASSISTANT`, `AI_MONTHLY_TOKEN_LIMIT`, `AI_USER_MONTHLY_TOKEN_LIMIT`;
   recommended `AI_PRICING_JSON` and `AI_MONTHLY_COST_LIMIT_USD`; optionally `AI_USER_REQUESTS_PER_MINUTE`,
   `AI_USER_DAILY_REQUESTS`, `AI_MAX_REQUEST_CHARS`, `AI_TIMEOUT_MS`. Set a spending limit on the OpenAI project too.
4. Start with demo companies (`AI_IN_DEMOS=on`), then add real companies one at a time to `AI_COMPANY_ALLOWLIST`.
5. Deploy, open Company setup → AI capabilities, confirm Ready or Limited, and ask one question per role.

**Disable immediately (no redeploy):** in the Supabase SQL editor run
`update private.ai_controls set paused = true, reason = '<why>', updated_at = now();`. Every AI request on every company
stops at its next request ("AI is paused by the platform owner."); deterministic features are unaffected. Resume with
`paused = false`. Longer term: remove the capability from `AI_CAPABILITIES` or the company from `AI_COMPANY_ALLOWLIST`
and redeploy, or revoke the key in the OpenAI dashboard.

**Remaining gaps:** no live evaluation of version 3 yet; one question can make up to 3 model calls, so limits count calls
rather than questions; the privacy notice and customer terms do not yet describe AI processing (§17). Simultaneous
requests are limited atomically since `20261120002500` (§6). Activation also needs that migration, after
`20261120002400`.

## 17. OpenAI data handling and the disclosures needed before activation (2026-10-25)

What OpenAI states for the API (checked 2026-10-25 from OpenAI's published pages; the owner should re-read them and the
Data Processing Addendum before activation, because terms change):

- **Training:** data sent to the API is not used to train OpenAI's models unless the account opts in (OpenAI, "Data
  controls in the OpenAI platform" and "Enterprise privacy").
- **Abuse monitoring:** API inputs and outputs may be retained for up to 30 days for service delivery and abuse
  monitoring, longer only where legally required, then removed.
- **`store: false`:** Taviron sends every Responses API request with `store: false`, so OpenAI does not keep the
  response as application state for later retrieval. It does **not** turn off the 30-day abuse-monitoring retention.
- **Zero Data Retention / Modified Abuse Monitoring:** available only with OpenAI's prior approval for eligible endpoints
  and use cases (contact OpenAI sales); not something Taviron can switch on in code. Not assumed.
- **Processing location:** the API is operated by OpenAI (United States unless a data-residency arrangement is made).

What Taviron actually sends (by design, §10 and §15): the person's question with names, references, email addresses
and phone numbers replaced or removed; codes (O1, L2, T3 …), catalog labels, dates and counts from tool results;
period totals. Never record ids, company ids, typed notes or descriptions, customer or employee names, or the key.
Taviron stores no prompts or answers; the ledger keeps counts only.

**Disclosures required before Ask Taviron is switched on for any real company (owner decisions; legal review advised):**
1. **Privacy notice** (`src/app/(site)/privacy/page.tsx`, currently a draft that does not mention AI): add that optional AI
   features, when a company switches them on, send pseudonymized operational data and the user's question to OpenAI as
   a service provider; not used for training; retained by OpenAI up to 30 days for abuse monitoring; not stored by
   Taviron; how to ask questions about it. Also list OpenAI where providers are listed ("Where it is stored" promises the
   list before general availability).
2. **Customer terms / order form or DPA:** name OpenAI as a sub-processor for the optional AI features, and record the
   customer company's choice to enable them (the `AI_COMPANY_ALLOWLIST` entry should follow that written choice).
3. **In-app notice:** the Ask Taviron page already labels answers as AI-generated and checked; add one line on first
   use saying questions are processed by OpenAI and not stored by Taviron (code change, small; not done yet).
4. **OpenAI account settings:** confirm data-sharing for training is off for the project, set a spending limit, and
   decide whether to apply for Zero Data Retention.

No public page was changed in this round: public wording is a person's decision (CLAUDE.md).
