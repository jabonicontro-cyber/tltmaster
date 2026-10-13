import type { EvalEvidence } from "./capabilities";

// Recorded evaluation runs (docs/AI.md §5). Add an entry only from a real run of `npm run ai:eval` — copy the evidence
// it prints. Never write or edit one by hand: a capability stays "Needs review" until its model has passing evidence.
export const EVAL_EVIDENCE: EvalEvidence[] = [];
