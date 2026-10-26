import type { EvalEvidence } from "./capabilities";

// Recorded evaluation runs (docs/AI.md §5). Add an entry only from a real run of `npm run ai:eval` — copy the evidence
// it prints. Never write or edit one by hand: a capability stays "Needs review" until its model has passing evidence.
export const EVAL_EVIDENCE: EvalEvidence[] = [
  // npm run ai:eval at 6060cfa, run by the owner on 2026-10-23.
  {
    "capability": "plan_explanation",
    "provider": "openai",
    "model": "gpt-5-mini",
    "evalVersion": 2,
    "ranAt": "2026-10-23T02:28:31.836Z",
    "cases": 3,
    "passed": 3,
    "criticalFailures": 0
  },
  {
    "capability": "ops_assistant",
    "provider": "openai",
    "model": "gpt-5-mini",
    "evalVersion": 2,
    "ranAt": "2026-10-23T02:28:41.071Z",
    "cases": 4,
    "passed": 4,
    "criticalFailures": 0
  },
  // npm run ai:eval at 8e941c8, GitHub Actions run 40225336674 ("AI evaluation (manual, paid)"), 2026-10-25.
  {
    "capability": "plan_explanation",
    "provider": "openai",
    "model": "gpt-5-mini",
    "evalVersion": 2,
    "ranAt": "2026-10-25T19:18:01.245Z",
    "cases": 3,
    "passed": 3,
    "criticalFailures": 0
  },
  {
    "capability": "ops_assistant",
    "provider": "openai",
    "model": "gpt-5-mini",
    "evalVersion": 3,
    "ranAt": "2026-10-25T19:18:15.933Z",
    "cases": 6,
    "passed": 6,
    "criticalFailures": 0
  },
  // npm run ai:eval at fa73397, GitHub Actions run 40367873194 ("AI evaluation (manual, paid)"), 2026-10-26.
  {
    "capability": "plan_explanation",
    "provider": "openai",
    "model": "gpt-5-mini",
    "evalVersion": 2,
    "ranAt": "2026-10-26T17:22:04.015Z",
    "cases": 3,
    "passed": 3,
    "criticalFailures": 0
  },
  {
    "capability": "ops_assistant",
    "provider": "openai",
    "model": "gpt-5-mini",
    "evalVersion": 3,
    "ranAt": "2026-10-26T17:22:26.069Z",
    "cases": 6,
    "passed": 6,
    "criticalFailures": 0
  },
  {
    "capability": "ticket_reading",
    "provider": "openai",
    "model": "gpt-5-mini",
    "evalVersion": 1,
    "ranAt": "2026-10-26T17:22:50.948Z",
    "cases": 5,
    "passed": 5,
    "criticalFailures": 0
  },
];
