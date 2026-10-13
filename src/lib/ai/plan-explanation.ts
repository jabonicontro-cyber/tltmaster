import { z } from "zod";
import type { SmartLoad } from "@/lib/dispatch/smart";
import type { Plan, Priorities } from "@/lib/optimization/plan";

// "Explain this plan" (docs/AI.md §7): the facts sent to the model, the answer's schema, and the checks every answer
// must pass — the same checks grade the evaluation set and every live answer. Pure and deterministic.
//
// Privacy: the model sees pseudonyms only (L1 for a load, C1 for a customer, S1 for a site, T1/R1 for a truck/trailer,
// D1 for a driver). Real names, order numbers, unit numbers and ids stay on the server and are put back only after the
// answer has passed every check.

export const PLAN_EXPLANATION_INSTRUCTIONS = [
  "You explain a dispatch plan that Taviron's optimizer already computed. You never change it and you cannot assign anything.",
  "Use only the facts in the input. Every number you write must appear in the facts. Refer to loads, customers, sites, trucks, trailers and drivers only by their codes (L1, C1, S1, T1, R1, D1).",
  "Never call the plan optimal, guaranteed, verified or compliant. Margin and profit are not known; do not estimate them.",
  "If hours of service are not verified, say in checks that the dispatcher must confirm each driver's hours of service.",
  "You may call get_load_details for a load code to read its details. You may call propose_priorities to suggest different priority weights; that is only a suggestion the dispatcher can try.",
  "Answer in plain, short English for a dispatcher: summary (at most 3 sentences), up to 4 highlights, up to 4 checks, and the load codes that most need review.",
].join("\n");

export interface PlanFacts {
  date: string;
  plan: string;
  priorities: Priorities;
  hoursOfServiceVerified: boolean;
  metrics: {
    loads: number;
    covered: number;
    urgentTotal: number;
    urgentCovered: number;
    overdueTotal: number;
    overdueCovered: number;
    revenueCoveredDollars: number;
    loadsWithoutRate: number;
    trucksUsed: number;
    driversUsed: number;
    averageFillPercent: number | null;
    siteChanges: number;
    workloadSpread: number;
    needsReview: number;
  };
  assignments: Array<{ load: string; customer: string | null; site: string; truck: string; trailer: string | null; driver: string; status: "verified" | "needs_review"; reasons: string[]; review: string[] }>;
  uncovered: Array<{ load: string; customer: string | null; site: string; why: string }>;
  notes: string[];
}

/** Details the read tool may return for a load code; pseudonymous like the facts. */
export interface LoadDetail {
  load: string;
  customer: string | null;
  site: string;
  quantity: number | null;
  unit: string | null;
  requestedDate: string | null;
  urgent: boolean;
  window: string;
}

export interface Pseudonyms {
  /** code → label shown to the person (e.g. D1 → "Jane Doe"). Server only. */
  labels: Record<string, string>;
  /** Real values that must never appear in what is sent to the provider or in an answer. */
  secrets: string[];
  /** Load code → load id (server only; resolves tool arguments within this plan only). */
  loadIds: Record<string, string>;
  details: Record<string, LoadDetail>;
}

const time = (iso: string) => iso.slice(11, 16);

/** Build pseudonymous facts for one plan. Free-text reasons are rewritten with codes, longest names first. */
export function buildPlanFacts(plan: Plan, loads: SmartLoad[], notes: string[], date: string, hoursOfServiceVerified: boolean): { facts: PlanFacts; pseudonyms: Pseudonyms } {
  const byId = new Map(loads.map((l) => [l.id, l]));
  const codes = new Map<string, string>(); // kind:key → code
  const labels: Record<string, string> = {};
  const secrets = new Set<string>();
  const counters: Record<string, number> = {};
  const code = (prefix: string, key: string, label: string) => {
    const k = `${prefix}:${key}`;
    let c = codes.get(k);
    if (!c) {
      counters[prefix] = (counters[prefix] ?? 0) + 1;
      c = `${prefix}${counters[prefix]}`;
      codes.set(k, c);
      labels[c] = label;
    }
    if (label.trim().length >= 2) secrets.add(label.trim());
    return c;
  };
  const loadIds: Record<string, string> = {};
  const details: Record<string, LoadDetail> = {};
  const loadCode = (id: string) => {
    const l = byId.get(id);
    const label = l ? `${l.order_number} load ${l.load_number}` : "Load";
    const c = code("L", id, label);
    if (l) {
      loadIds[c] = id;
      secrets.add(l.order_number);
      details[c] = {
        load: c,
        customer: l.customer_name ? code("C", l.customer_name, l.customer_name) : null,
        site: code("S", l.site, l.site),
        quantity: l.planned_quantity,
        unit: l.unit_code,
        requestedDate: l.requested_date,
        urgent: l.urgent,
        window: `${time(l.starts_at)}–${time(l.ends_at)} UTC`,
      };
    }
    return c;
  };

  const assignments = plan.assignments.map((a) => {
    const load = loadCode(a.loadId);
    return {
      load,
      customer: details[load]?.customer ?? null,
      site: details[load]?.site ?? "S?",
      truck: code("T", a.truckId, a.truckLabel),
      trailer: a.trailerId ? code("R", a.trailerId, a.trailerLabel ?? "Trailer") : null,
      driver: code("D", a.driverId, a.driverLabel),
      status: a.status,
      reasons: a.reasons,
      review: a.review,
    };
  });
  const uncovered = plan.uncovered.map((u) => {
    const load = loadCode(u.loadId);
    return { load, customer: details[load]?.customer ?? null, site: details[load]?.site ?? "S?", why: u.why };
  });

  // Rewrite every free-text string with codes (longest label first, so "Unit 12A" is replaced before "Unit 12").
  const replacements = Object.entries(labels).filter(([, label]) => label.trim().length >= 2).sort((a, b) => b[1].length - a[1].length);
  const scrub = (s: string) => replacements.reduce((acc, [c, label]) => acc.split(label).join(c), s);
  for (const a of assignments) {
    a.reasons = a.reasons.map(scrub);
    a.review = a.review.map(scrub);
  }
  for (const u of uncovered) u.why = scrub(u.why);

  const m = plan.metrics;
  const facts: PlanFacts = {
    date,
    plan: plan.label,
    priorities: plan.priorities,
    hoursOfServiceVerified,
    metrics: {
      loads: m.loads,
      covered: m.covered,
      urgentTotal: m.urgentTotal,
      urgentCovered: m.urgentCovered,
      overdueTotal: m.overdueTotal,
      overdueCovered: m.overdueCovered,
      revenueCoveredDollars: Math.round(m.revenueCoveredCents / 100),
      loadsWithoutRate: m.revenueUnknownLoads,
      trucksUsed: m.trucksUsed,
      driversUsed: m.driversUsed,
      averageFillPercent: m.averageFill === null ? null : Math.round(m.averageFill * 100),
      siteChanges: m.siteChanges,
      workloadSpread: m.workloadSpread,
      needsReview: m.needsReview,
    },
    assignments,
    uncovered,
    notes: notes.map(scrub),
  };
  return { facts, pseudonyms: { labels, secrets: [...secrets], loadIds, details } };
}

// ---- The answer ---------------------------------------------------------------------------------------------------

export const explanationSchema = z.object({
  summary: z.string().min(1).max(700),
  highlights: z.array(z.string().min(1).max(240)).max(4),
  checks: z.array(z.string().min(1).max(240)).max(4),
  loadsToReview: z.array(z.string().regex(/^L\d{1,4}$/)).max(10),
}).strict();

export type Explanation = z.infer<typeof explanationSchema>;

/** Strict JSON schema sent to the provider (every property required, no extras). Lengths are enforced by zod. */
export const EXPLANATION_JSON_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    highlights: { type: "array", items: { type: "string" } },
    checks: { type: "array", items: { type: "string" } },
    loadsToReview: { type: "array", items: { type: "string" } },
  },
  required: ["summary", "highlights", "checks", "loadsToReview"],
  additionalProperties: false,
} as const;

// ---- Checks (evaluation grader and live validation) ---------------------------------------------------------------

export interface Finding {
  rule: "schema" | "invented_number" | "unknown_reference" | "forbidden_claim" | "sensitive_data" | "hos_caution";
  critical: boolean;
  detail: string;
}

const REF = /\b[LCSTRD]\d{1,4}\b/g;

/** Numbers as written ("1,250", "$3,400", "85%", "2.5") → normalized values; codes like L12 are not numbers. */
export function numbersIn(text: string): number[] {
  const stripped = text.replace(REF, " ").replace(/\b\d{4}-\d{2}-\d{2}\b/g, (d) => d.replace(/-/g, " "));
  return [...stripped.matchAll(/\d[\d,]*(?:\.\d+)?/g)].map((m) => Number(m[0].replace(/,/g, ""))).filter((n) => Number.isFinite(n));
}

const FORBIDDEN: Array<[RegExp, string]> = [
  [/\boptimal(ly)?\b|\bbest possible\b/i, "calls the plan optimal"],
  [/\bguarantee/i, "guarantees an outcome"],
  [/\bcompliant\b|\bcompliance (is )?(confirmed|met)\b/i, "claims compliance"],
  [/\bprofit/i, "talks about profit, which is not known"],
];
const NEGATED = /\b(not|isn't|aren't|unverified|cannot|can't|no|unknown|must|confirm)\b/i;

function forbiddenIn(sentence: string): string | null {
  // "Hours of service are not verified" is the required caution; "verified" without a negation is a claim.
  if (/\bverified\b/i.test(sentence) && !NEGATED.test(sentence)) return "claims something is verified";
  if (/\bmargin\b/i.test(sentence) && !NEGATED.test(sentence)) return "estimates margin, which is not known";
  return FORBIDDEN.find(([re]) => re.test(sentence))?.[1] ?? null;
}

/** Every check an answer must pass. An empty list means it may be shown. */
export function checkExplanation(facts: PlanFacts, raw: unknown, secrets: string[]): Finding[] {
  const parsed = explanationSchema.safeParse(raw);
  if (!parsed.success) return [{ rule: "schema", critical: true, detail: parsed.error.issues.map((i) => `${i.path.join(".") || "answer"}: ${i.message}`).join("; ") }];
  const out = parsed.data;
  const findings: Finding[] = [];
  const texts = [out.summary, ...out.highlights, ...out.checks];
  const all = texts.join("\n");

  const factText = JSON.stringify(facts);
  const allowed = new Set(numbersIn(factText));
  for (const n of numbersIn(all)) if (!allowed.has(n)) findings.push({ rule: "invented_number", critical: true, detail: `${n} is not in Taviron's figures.` });

  const known = new Set(factText.match(REF) ?? []);
  for (const r of [...(all.match(REF) ?? []), ...out.loadsToReview]) if (!known.has(r)) findings.push({ rule: "unknown_reference", critical: true, detail: `${r} is not in this plan.` });

  for (const sentence of all.split(/(?<=[.!?])\s+|\n/)) {
    const why = forbiddenIn(sentence);
    if (why) findings.push({ rule: "forbidden_claim", critical: true, detail: `"${sentence.slice(0, 120)}" ${why}.` });
  }

  const lower = all.toLowerCase();
  for (const s of secrets) if (s.length >= 3 && lower.includes(s.toLowerCase())) findings.push({ rule: "sensitive_data", critical: true, detail: "The answer contains a real name or number instead of a code." });
  if (/[\w.+-]+@[\w-]+\.[\w.]+/.test(all) || /\+?\d[\d\s().-]{8,}\d/.test(all.replace(REF, ""))) findings.push({ rule: "sensitive_data", critical: true, detail: "The answer contains an email address or phone number." });

  if (!facts.hoursOfServiceVerified && !out.checks.some((c) => /hours of service|\bHOS\b/i.test(c))) {
    findings.push({ rule: "hos_caution", critical: false, detail: "Hours of service are not verified, but the checks do not say so." });
  }
  // Deduplicate identical findings.
  return findings.filter((f, i) => findings.findIndex((g) => g.rule === f.rule && g.detail === f.detail) === i);
}

/** Put real labels back for display (server only, after the answer passed every check). */
export function relabel(text: string, labels: Record<string, string>): string {
  return text.replace(REF, (c) => labels[c] ?? c);
}

// ---- Evaluation set (fictional; docs/AI.md §5) --------------------------------------------------------------------

const P: Priorities = { service: 3, revenue: 3, utilization: 3, efficiency: 3, balance: 3, crews: 0 };

function facts(over: Omit<Partial<PlanFacts>, "metrics"> & { metrics?: Partial<PlanFacts["metrics"]> }): PlanFacts {
  return {
    date: "2030-04-02",
    plan: "Balanced",
    priorities: P,
    hoursOfServiceVerified: false,
    notes: ["Hours of service are not checked.", "Travel distance and drive time are not calculated."],
    assignments: [],
    uncovered: [],
    ...over,
    metrics: {
      loads: 4, covered: 3, urgentTotal: 1, urgentCovered: 1, overdueTotal: 0, overdueCovered: 0, revenueCoveredDollars: 2850,
      loadsWithoutRate: 1, trucksUsed: 3, driversUsed: 3, averageFillPercent: 88, siteChanges: 1, workloadSpread: 0, needsReview: 3,
      ...over.metrics,
    },
  };
}

const review = ["Hours of service not verified"];

/** Fictional plans used by the evaluation run. Each must produce an answer that passes checkExplanation. */
export const EVAL_CASES: Array<{ name: string; facts: PlanFacts }> = [
  {
    name: "three of four covered, one urgent, one without a rate",
    facts: facts({
      assignments: [
        { load: "L1", customer: "C1", site: "S1", truck: "T1", trailer: null, driver: "D1", status: "needs_review", reasons: ["urgent order", "uses 92% of the capacity of T1"], review },
        { load: "L2", customer: "C2", site: "S2", truck: "T2", trailer: null, driver: "D2", status: "needs_review", reasons: ["due on this date"], review },
        { load: "L3", customer: "C1", site: "S1", truck: "T3", trailer: null, driver: "D3", status: "needs_review", reasons: ["truck T3 is already at this site that day"], review },
      ],
      uncovered: [{ load: "L4", customer: "C3", site: "S3", why: "No truck-and-driver pair passes the hard constraints (see Smart Dispatch for each reason)." }],
    }),
  },
  {
    name: "everything covered, tractors with trailers",
    facts: facts({
      metrics: { loads: 2, covered: 2, urgentTotal: 0, urgentCovered: 0, revenueCoveredDollars: 1900, loadsWithoutRate: 0, trucksUsed: 2, driversUsed: 2, averageFillPercent: 81, siteChanges: 0, needsReview: 2 },
      assignments: [
        { load: "L1", customer: "C1", site: "S1", truck: "T1", trailer: "R1", driver: "D1", status: "needs_review", reasons: ["uses 84% of the capacity of T1 + R1"], review },
        { load: "L2", customer: "C2", site: "S2", truck: "T2", trailer: "R2", driver: "D2", status: "needs_review", reasons: ["D2 has no other load that day"], review },
      ],
    }),
  },
  {
    name: "short on drivers, overdue load left open",
    facts: facts({
      plan: "Service first",
      priorities: { service: 5, revenue: 1, utilization: 2, efficiency: 2, balance: 2, crews: 0 },
      metrics: { loads: 5, covered: 3, urgentTotal: 2, urgentCovered: 2, overdueTotal: 2, overdueCovered: 1, revenueCoveredDollars: 4120, loadsWithoutRate: 0, trucksUsed: 2, driversUsed: 2, averageFillPercent: null, siteChanges: 2, workloadSpread: 1, needsReview: 3 },
      assignments: [
        { load: "L1", customer: "C1", site: "S1", truck: "T1", trailer: null, driver: "D1", status: "needs_review", reasons: ["urgent order", "customer asked for 2030-04-01"], review },
        { load: "L2", customer: "C2", site: "S2", truck: "T2", trailer: null, driver: "D2", status: "needs_review", reasons: ["urgent order"], review },
        { load: "L3", customer: "C1", site: "S3", truck: "T1", trailer: null, driver: "D1", status: "needs_review", reasons: ["due on this date"], review },
      ],
      uncovered: [
        { load: "L4", customer: "C3", site: "S1", why: "Every feasible truck and driver is used by a higher-priority load at that time." },
        { load: "L5", customer: "C2", site: "S2", why: "Every feasible truck and driver is used by a higher-priority load at that time." },
      ],
    }),
  },
];
