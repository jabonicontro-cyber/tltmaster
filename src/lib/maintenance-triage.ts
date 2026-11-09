import { WO_CATEGORIES, WO_URGENCIES } from "./maintenance";

// Maintenance request triage (owner directive 2026-10-25). A deterministic first pass over what a driver or mechanic
// reported: it quotes what the text says, suggests a category, urgency and whether a safety review is needed, lists the
// questions the report leaves open, and points at related open work orders. It never invents facts: every "fact" is a
// sentence copied from the report, and anything not stated stays unknown. A person accepts, edits or rejects it, and
// nothing it says can mark a vehicle safe or lift a restriction.

export type WoCategory = keyof typeof WO_CATEGORIES;
export type WoUrgency = keyof typeof WO_URGENCIES;

export interface TriageInput {
  title: string;
  description: string;
  /** Other open work orders on the same truck or trailer. */
  openOnUnit: Array<{ id: string; number: string; title: string; category: string }>;
  /**
   * What the work order already says. A suggestion never lowers the urgency and never drops the safety flag
   * (mechanic walkthrough 2026-11-09, B3): it starts from the higher of the two.
   */
  current?: { urgency: WoUrgency; safetyCritical: boolean };
}

export interface TriageSuggestion {
  version: 1;
  problem: string;
  /** Sentences quoted from the report, unchanged. */
  facts: string[];
  symptoms: string[];
  onset: string | null;
  worsening: "yes" | "no" | "unknown";
  questions: string[];
  category: WoCategory;
  urgency: WoUrgency;
  safetyReview: boolean;
  /** Why the category, urgency and safety flag were suggested, in plain words. */
  reasons: string[];
  related: Array<{ id: string; number: string; title: string }>;
}

const CATEGORY_RULES: Array<[WoCategory, RegExp]> = [
  ["brakes", /\bbrak|air (leak|loss|pressure)|chamber|slack adjust|abs\b|\bpads?\b|rotor|drum/i],
  ["tires", /\btire|tyre|flat\b|tread|blow ?out|lug ?nut|wheel (seal|bearing)/i],
  ["electrical", /light|electric|wiring|battery|alternator|fuse|starter|dash (light|warning)|check engine/i],
  ["engine", /engine|overheat|coolant|oil (leak|pressure)|smoke|knock|turbo|def\b|regen|exhaust|stall/i],
  ["hydraulics", /hydraulic|hoist|dump (box|bed|body)|cylinder|pto\b|tailgate/i],
  ["body", /mirror|windshield|door|bumper|fender|body damage|tarp|seat|step\b/i],
  ["inspection", /inspection|dot\b|annual|pre-?trip|post-?trip/i],
];

// Words that mean the vehicle may not be safe to drive until someone qualified looks at it.
// Tire damage counts too (B3): a cut or bulging sidewall, a low or flat tire, a blowout or tread separation can fail on
// the road. "Cut" only counts next to a tire word, so "engine cuts out" is not read as tire damage.
const SAFETY = /\bbrak|steer|air (leak|loss)|low air|tire (blow|separation)|blow ?out|tread separat|sidewall|bulg(e|es|ing)\b|low tire|tires? (is |are |looks? |running |seems? )?(low|flat)\b|\bflat\b(?! ?bed)|(tire|tyre|sidewall|tread)[^.\n]{0,40}\bcuts?\b|\bcuts?\b[^.\n]{0,40}\b(tire|tyre|sidewall|tread)|wheel (off|loose|came)|lug ?nuts? (loose|missing)|smoke|fire|fuel leak|no (head|brake|tail) ?lights?|headlights? out|coupl|fifth wheel|kingpin|frame crack|crack(ed)? (frame|spring)|suspension|spring broke|hitch/i;
const URGENT = /won'?t start|can'?t (drive|move)|stuck|stranded|tow|on the (shoulder|side of the road)|immediately|right away|now\b/i;
const WORSENING = /(getting|got|growing) (worse|louder|bigger)|worse(ning)?\b|more often|increasing|keeps (getting|happening)/i;
const NOT_WORSENING = /(same as|no worse|not (getting )?worse|stable|hasn'?t changed)/i;
const ONSET = /\b(this morning|yesterday|today|last (night|week|trip|load)|since [^.,;]+|for (the )?(last |past )?\d+ \w+|started [^.,;]+|began [^.,;]+|after [^.,;]+)/i;
const SYMPTOM = /\b(leak\w*|nois\w*|squeal\w*|grind\w*|vibrat\w*|pull\w* (left|right)|smoke|smell\w*|warning light|overheat\w*|won'?t start|stall\w*|hiss\w*|knock\w*|clunk\w*|shak\w*|soft pedal|loss of power)\b/gi;

/** Sentences of the report, trimmed, without empties. */
/** The matched text widened to whole words ("brak" in "brakes" shows as "brakes"). */
function wholeWords(text: string, start: number, length: number): string {
  let a = start;
  let b = start + length;
  while (a > 0 && /[\p{L}\p{N}]/u.test(text[a - 1])) a--;
  while (b < text.length && /[\p{L}\p{N}]/u.test(text[b])) b++;
  return text.slice(a, b);
}

function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter((s) => s.length >= 3).slice(0, 8);
}

export function triageRules(input: TriageInput): TriageSuggestion {
  const text = `${input.title}\n${input.description}`.trim();
  const reasons: string[] = [];

  const category = (CATEGORY_RULES.find(([, re]) => re.test(text))?.[0] ?? "repair") as WoCategory;
  reasons.push(category === "repair" ? "No specific system named, so a general repair." : `Mentions ${WO_CATEGORIES[category].toLowerCase()}.`);

  const safetyMatch = text.match(SAFETY);
  const safetyReview = Boolean(safetyMatch);
  if (safetyMatch) reasons.push(`"${wholeWords(text, safetyMatch.index ?? 0, safetyMatch[0].length)}" can affect safe operation: a qualified person should check it before the vehicle runs.`);

  const urgentMatch = text.match(URGENT);
  let urgency: WoUrgency = urgentMatch || (safetyReview && /won'?t|can'?t|fail|out\b|broke/i.test(text)) ? "immediate" : safetyReview ? "high" : "normal";
  if (urgentMatch) reasons.push(`"${urgentMatch[0]}" suggests the vehicle cannot run.`);
  // Never below what the work order already says (B3).
  let safety = safetyReview;
  if (input.current) {
    if (URGENCY_RANK[input.current.urgency] > URGENCY_RANK[urgency]) {
      urgency = input.current.urgency;
      reasons.push(`The work order is already ${WO_URGENCIES[input.current.urgency].toLowerCase()} urgency: a suggestion never lowers it.`);
    }
    if (input.current.safetyCritical && !safety) {
      safety = true;
      reasons.push("The work order is already safety-critical: it stays that way until an authorized inspection clears it.");
    }
  }

  const onset = text.match(ONSET)?.[0] ?? null;
  const worsening = NOT_WORSENING.test(text) ? "no" : WORSENING.test(text) ? "yes" : "unknown";
  const symptoms = [...new Set([...text.matchAll(SYMPTOM)].map((m) => m[0].toLowerCase()))].slice(0, 6);

  const questions: string[] = [];
  if (!onset) questions.push("When did it start?");
  if (worsening === "unknown") questions.push("Is it getting worse, or the same as when it started?");
  if (!/drivable|can (still )?drive|parked|in the yard|at the shop|on the road|shoulder/i.test(text)) questions.push("Is the vehicle parked, or still being driven?");
  if (category === "brakes" && !/psi|gauge|pressure/i.test(text)) questions.push("What does the air pressure gauge show, and does it drop when the brakes are applied?");
  if (category === "tires" && !/(left|right|front|rear|steer|drive|trailer) /i.test(text)) questions.push("Which tire (axle and side)?");
  if (symptoms.length === 0) questions.push("What exactly happens: a noise, a warning light, a leak, a vibration?");

  const related = input.openOnUnit
    .filter((w) => w.category === category || category === "repair")
    .slice(0, 5)
    .map(({ id, number, title }) => ({ id, number, title }));

  return {
    version: 1,
    problem: input.title.trim(),
    facts: sentences(input.description),
    symptoms,
    onset,
    worsening,
    questions: questions.slice(0, 5),
    category,
    urgency,
    safetyReview: safety,
    reasons,
    related,
  };
}

/** Urgency from lowest to highest. */
export const URGENCY_RANK: Record<WoUrgency, number> = { low: 0, normal: 1, high: 2, immediate: 3 };

/** The higher of two urgencies. */
export function higherUrgency(a: WoUrgency, b: WoUrgency): WoUrgency {
  return URGENCY_RANK[a] >= URGENCY_RANK[b] ? a : b;
}

/** What a work order says now: the starting point for accepting or editing a suggestion. */
export interface TriageCurrent { category: WoCategory; urgency: WoUrgency; safetyCritical: boolean }
export interface TriageValues { category: WoCategory; urgency: WoUrgency; safetyCritical: boolean }

export interface TriageChanges {
  /** What the work order ends up with. */
  next: TriageValues;
  /** Each change in plain words ("Urgency: Normal → High"). Empty when nothing changes. */
  changes: string[];
  /** What stays as it is although the suggestion said otherwise, in plain words. */
  kept: string[];
  /** The urgency goes down (only a person's own edit can do this, never a suggestion). */
  lowersUrgency: boolean;
}

/** The changes from the work order as it is to `next`, in plain words. The safety flag is never removed here. */
export function triageChanges(current: TriageCurrent, next: TriageValues): TriageChanges {
  const safety = current.safetyCritical || next.safetyCritical;
  const changes: string[] = [];
  const kept: string[] = [];
  if (next.category !== current.category) changes.push(`Category: ${WO_CATEGORIES[current.category]} → ${WO_CATEGORIES[next.category]}`);
  const lowersUrgency = URGENCY_RANK[next.urgency] < URGENCY_RANK[current.urgency];
  if (next.urgency !== current.urgency) changes.push(`Urgency: ${WO_URGENCIES[current.urgency]} → ${WO_URGENCIES[next.urgency]}${lowersUrgency ? " (lower)" : ""}`);
  if (safety && !current.safetyCritical) changes.push("Marks it safety-critical: the vehicle stays out of service until an authorized inspection clears it.");
  if (current.safetyCritical && !next.safetyCritical) kept.push("It stays safety-critical: only an authorized inspection clears it.");
  return { next: { ...next, safetyCritical: safety }, changes, kept, lowersUrgency };
}

/**
 * Accepting a suggestion (B3, safety): the suggested category, the higher of the current and the suggested urgency, and
 * safety-critical when either says so. A suggestion can raise the urgency or add the safety flag, never lower or remove.
 */
export function acceptTriage(current: TriageCurrent, suggestion: Pick<TriageSuggestion, "category" | "urgency" | "safetyReview">): TriageChanges {
  const urgency = higherUrgency(current.urgency, suggestion.urgency);
  const out = triageChanges(current, { category: suggestion.category, urgency, safetyCritical: current.safetyCritical || suggestion.safetyReview });
  if (urgency !== suggestion.urgency) out.kept.unshift(`Urgency stays ${WO_URGENCIES[current.urgency]} (the suggestion said ${WO_URGENCIES[suggestion.urgency]}; the higher one is kept).`);
  if (current.safetyCritical && !suggestion.safetyReview) out.kept.push("It stays safety-critical: only an authorized inspection clears it.");
  return out;
}

/** A driver report's own kind (src/lib/driver/rules.ts REPORT_KIND_LABELS). */
export type DriverReportKind = "delay" | "cannot_complete" | "breakdown" | "equipment_issue" | "inspection_issue";

export interface ReportDraft {
  title: string;
  description: string;
  category: WoCategory;
  urgency: WoUrgency;
  safety_critical: boolean;
  /** Why category, urgency and the safety flag were suggested, in plain words (shown with the form). */
  reasons: string[];
}

const atLeast = (u: WoUrgency, min: WoUrgency) => higherUrgency(u, min);

/** The first sentence of the report as a short title (at most 80 characters, cut on a word). */
export function reportTitle(text: string, fallback: string): string {
  const first = text.trim().split(/(?<=[.!?])\s+|\n+/)[0]?.trim().replace(/[.!?]+$/, "") ?? "";
  if (first.length < 3) return fallback;
  if (first.length <= 80) return first;
  const cut = first.slice(0, 80);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 40)).trim()}…`;
}

/**
 * A work order draft from a driver report (first-day review 2026-11-09): the title and description come from the
 * driver's own words, and category, urgency and the safety flag are suggestions (the same rules as triage, plus the
 * report's kind: a breakdown suggests safety-critical and high urgency). The person creating the work order sees why
 * and changes anything that is wrong; nothing is saved until they create it.
 */
export function workOrderFromReport(report: { kind: DriverReportKind | string; description: string }, kindLabel: string): ReportDraft {
  const description = report.description.trim();
  const t = triageRules({ title: "", description, openOnUnit: [] });
  const reasons = t.reasons.filter((r) => !r.startsWith("No specific system"));
  let safety = t.safetyReview;
  let urgency = t.urgency;
  if (report.kind === "breakdown") {
    if (!safety) reasons.push("The driver reported a breakdown: the vehicle may not be safe to run until it is checked.");
    safety = true;
  }
  if (safety) urgency = atLeast(urgency, "high");
  return { title: reportTitle(description, kindLabel), description, category: t.category, urgency, safety_critical: safety, reasons };
}
