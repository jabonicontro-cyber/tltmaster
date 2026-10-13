# AI runtime foundation

How Taviron calls AI models: the provider-independent interface, the OpenAI adapter, configuration, readiness gates,
evaluations, usage and budgets, tools and approvals. Master plan §12 B6. First built 2026-10-13.

**Status:**
- Code: written, tested with mocked provider responses, and committed locally (not pushed).
- Usage-ledger migration `20261110000100_ai_usage.sql`: applied to the local database only. The hosted database needs
  the owner's approval (DEPLOYMENT §2a).
- Real OpenAI calls: never made from this repository's tests. No evaluation evidence has been recorded, so every
  capability is **Blocked** until the owner configures it, and then **Needs review** until a live evaluation passes.

## 1. What exists

| Piece | File |
| --- | --- |
| Provider-independent types, errors and the `AiProvider` interface | `src/server/ai/types.ts` |
| OpenAI adapter (Responses API) | `src/server/ai/openai.ts` |
| Configuration (server only) | `src/server/ai/config.ts` |
| Capabilities and readiness gates (pure) | `src/lib/ai/capabilities.ts` |
| Recorded evaluation evidence (empty) | `src/lib/ai/evidence.ts` |
| Tool registry: read / propose / execute, approval | `src/server/ai/tools.ts` |
| Orchestrator: gate, budget, rate limit, tool loop, validation, usage, fallback | `src/server/ai/run.ts` |
| Server wiring: provider, session ledger, gates | `src/server/ai/gates.ts` |
| First capability, "Explain this plan" | `src/lib/ai/plan-explanation.ts`, `src/server/ai/plan-explanation.ts`, `explainPlan` in `src/app/(app)/dispatch/plan/actions.ts`, `src/components/dispatch/plan-explanation.tsx` |
| Evaluation runner, and the opt-in live run | `src/server/ai/evals.ts`, `tests/live/ai-eval.live.test.ts` (`npm run ai:eval`) |
| Usage ledger | `supabase/migrations/20261110000100_ai_usage.sql` (rollback in `supabase/rollbacks/`) |
| Status per capability | Company setup (`/setup`), "AI capabilities" section |

Nothing else in the product calls a model. Smart Dispatch and Plan the day stay deterministic. The AI explanation
is an optional layer on top of the plan and never changes it.

## 2. Request flow

Every request follows these steps:

1. **Permission.** The server action checks the person's permission from their session (`assertPermission`).
2. **Recompute on the server.** The server recomputes the data the request is about. Numbers sent by the browser are
   never trusted.
3. **Readiness gate** (§4). Only Ready or Limited may continue.
4. **Ledger, rate limit and budget** (§6). If the ledger cannot be read, nothing is sent. Nothing is sent either when
   the company's per-minute call limit is reached or the monthly token cap would be exceeded.
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

## 4. Readiness gates

`evaluateGate` (pure) decides one of four states per capability and person. The same function serves the server and
the setup page.

| State | Meaning | When |
| --- | --- | --- |
| **Blocked** | Never calls a model | Any of: no permission, no provider or key, malformed AI settings, capability not switched on, no model, provider lacks structured output, no monthly token limit, usage ledger unavailable, demo company without `AI_IN_DEMOS=on`, monthly limit used up. |
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
- **Rate limit.** Per company, counted in the ledger over the last minute.
- **Cost.** Shown as "estimated cost" and kept separate from reported tokens. It is null rather than guessed when no
  price is configured.
- **Known limits:**
  - Any member of a company can call `record_ai_usage`, so a member could inflate their own company's usage. That only
    uses up their company's AI budget sooner; it exposes nothing.
  - Two simultaneous requests can both pass the budget check (no reservation). With 700 output tokens per call and
    3 rounds, the overshoot is small.

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

Error messages never include the key, the request body or model arguments. People see "AI explanation unavailable:
… The plan itself is unchanged."

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
- `tests/e2e/plan-the-day.spec.ts`: the Blocked state on Plan the day and Company setup in the presenter demo.
