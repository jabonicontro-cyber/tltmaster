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
const SAFETY = /\bbrak|steer|air (leak|loss)|low air|tire (blow|separation)|blow ?out|wheel (off|loose|came)|lug ?nuts? (loose|missing)|smoke|fire|fuel leak|no (head|brake|tail) ?lights?|headlights? out|coupl|fifth wheel|kingpin|frame crack|crack(ed)? (frame|spring)|suspension|spring broke|hitch/i;
const URGENT = /won'?t start|can'?t (drive|move)|stuck|stranded|tow|on the (shoulder|side of the road)|immediately|right away|now\b/i;
const WORSENING = /(getting|got|growing) (worse|louder|bigger)|worse(ning)?\b|more often|increasing|keeps (getting|happening)/i;
const NOT_WORSENING = /(same as|no worse|not (getting )?worse|stable|hasn'?t changed)/i;
const ONSET = /\b(this morning|yesterday|today|last (night|week|trip|load)|since [^.,;]+|for (the )?(last |past )?\d+ \w+|started [^.,;]+|began [^.,;]+|after [^.,;]+)/i;
const SYMPTOM = /\b(leak\w*|nois\w*|squeal\w*|grind\w*|vibrat\w*|pull\w* (left|right)|smoke|smell\w*|warning light|overheat\w*|won'?t start|stall\w*|hiss\w*|knock\w*|clunk\w*|shak\w*|soft pedal|loss of power)\b/gi;

/** Sentences of the report, trimmed, without empties. */
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
  if (safetyMatch) reasons.push(`"${safetyMatch[0]}" can affect safe operation: a qualified person should check it before the vehicle runs.`);

  const urgentMatch = text.match(URGENT);
  const urgency: WoUrgency = urgentMatch || (safetyReview && /won'?t|can'?t|fail|out\b|broke/i.test(text)) ? "immediate" : safetyReview ? "high" : "normal";
  if (urgentMatch) reasons.push(`"${urgentMatch[0]}" suggests the vehicle cannot run.`);

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
    safetyReview,
    reasons,
    related,
  };
}
