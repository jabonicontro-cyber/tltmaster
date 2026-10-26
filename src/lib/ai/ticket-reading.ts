// "Read a ticket photo" (B84, docs/AI.md §17): what the model is asked, the answer's schema and checks, the
// cross-checks against what was entered and the order, and the evaluation set. Pure: no network or database access.
// The reading is shown to a reviewer as an AI reading to check against the photo; it never changes or accepts a ticket.

export const TICKET_READING_INSTRUCTIONS = [
  "You read one photo of a paper or scale delivery ticket from a hauling company.",
  "Copy only what is printed or written on the ticket. Never guess, infer or complete a value: if a value is missing, cut off, covered or not clearly legible, return null for it.",
  "ticket_number: the ticket's own number as printed (not a phone number, PO or order number).",
  "date: the delivery or weigh date as YYYY-MM-DD; null when the year, month or day is not legible.",
  "material: the product or material name as printed, at most 60 characters.",
  "quantity and unit: the delivered quantity and its unit as printed (for example tons, TN, loads, yd). For a scale ticket with a net weight in tons, quantity is that net weight.",
  "gross_weight, tare_weight, net_weight and weight_unit: as printed on a scale ticket; null when not printed. Do not compute a missing weight from the others.",
  "truck: the truck or unit number as printed.",
  "readable: false when the image is not a delivery or scale ticket or nothing on it can be read; then every other value is null.",
  "Do not copy names of people or companies, addresses, phone numbers or signatures into any field.",
].join("\n");

const nullable = (type: "string" | "number") => ({ type: [type, "null"] });

export const READING_JSON_SCHEMA = {
  type: "object",
  properties: {
    readable: { type: "boolean" },
    ticket_number: nullable("string"),
    date: nullable("string"),
    material: nullable("string"),
    quantity: nullable("number"),
    unit: nullable("string"),
    gross_weight: nullable("number"),
    tare_weight: nullable("number"),
    net_weight: nullable("number"),
    weight_unit: nullable("string"),
    truck: nullable("string"),
  },
  required: ["readable", "ticket_number", "date", "material", "quantity", "unit", "gross_weight", "tare_weight", "net_weight", "weight_unit", "truck"],
  additionalProperties: false,
} as const;

export interface TicketReading {
  readable: boolean;
  ticket_number: string | null;
  date: string | null;
  material: string | null;
  quantity: number | null;
  unit: string | null;
  gross_weight: number | null;
  tare_weight: number | null;
  net_weight: number | null;
  weight_unit: string | null;
  truck: string | null;
}

export const READING_FIELDS = ["ticket_number", "date", "material", "quantity", "unit", "gross_weight", "tare_weight", "net_weight", "weight_unit", "truck"] as const;
type Field = (typeof READING_FIELDS)[number];
const TEXT_FIELDS: Field[] = ["ticket_number", "date", "material", "unit", "weight_unit", "truck"];
const NUMBER_FIELDS: Field[] = ["quantity", "gross_weight", "tare_weight", "net_weight"];

export interface ReadingFinding {
  rule: "schema" | "leak" | "invented" | "wrong" | "missed";
  /** Critical findings fail an evaluation run outright and are never shown. */
  critical: boolean;
  detail: string;
}

const EMAIL = /[\w.+-]+@[\w-]+\.[\w.]+/;
const PHONE = /\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Schema and leak checks for a live answer. Returns the reading, or the reasons it is not shown. */
export function checkReading(raw: unknown): { ok: true; value: TicketReading } | { ok: false; findings: ReadingFinding[] } {
  const findings: ReadingFinding[] = [];
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== "object" || typeof r.readable !== "boolean") return { ok: false, findings: [{ rule: "schema", critical: true, detail: "Not a ticket reading." }] };
  for (const f of TEXT_FIELDS) {
    const v = r[f];
    if (v !== null && (typeof v !== "string" || v.length > 60)) findings.push({ rule: "schema", critical: true, detail: `${f} is not short text.` });
    else if (typeof v === "string" && (EMAIL.test(v) || PHONE.test(v))) findings.push({ rule: "leak", critical: true, detail: `${f} holds contact details.` });
  }
  for (const f of NUMBER_FIELDS) {
    const v = r[f];
    if (v !== null && (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 999_999)) findings.push({ rule: "schema", critical: true, detail: `${f} is not a plausible number.` });
  }
  if (typeof r.date === "string" && !(ISO_DATE.test(r.date) && !Number.isNaN(Date.parse(`${r.date}T00:00:00Z`)))) findings.push({ rule: "schema", critical: true, detail: "date is not a calendar date." });
  if (r.readable === false && READING_FIELDS.some((f) => r[f] !== null)) findings.push({ rule: "schema", critical: true, detail: "An unreadable photo returned values." });
  return findings.length ? { ok: false, findings } : { ok: true, value: r as unknown as TicketReading };
}

// ---------------------------------------------------------------------------
// Cross-checks: the reading against the entered ticket and the order (shown to the reviewer)
// ---------------------------------------------------------------------------

export type CheckVerdict = "matches" | "differs" | "not_read" | "nothing_to_compare";

export interface CrossCheck {
  key: "ticket_number" | "date" | "material" | "quantity" | "weights" | "truck" | "duplicate";
  label: string;
  /** What the AI read from the photo (null: not read). */
  read: string | null;
  /** What Taviron holds (entered on the ticket or from the order). */
  recorded: string | null;
  verdict: CheckVerdict;
  note?: string;
}

export interface RecordedTicket {
  externalReference: string | null;
  /** Business date of delivered_at, YYYY-MM-DD. */
  deliveredDate: string;
  /** The load's planned date. */
  loadDate: string;
  lineDescription: string;
  quantity: number;
  unitCode: string;
  unitLabel: string;
  truckUnit: string | null;
  /** Other live tickets of this company whose paper ticket number matches what was read. */
  otherTicketsWithNumber: string[];
}

/** Printed units to the product's unit codes. Unknown units are compared as "differs" with a note, never converted. */
const UNIT_ALIASES: Record<string, string> = {
  t: "ton", tn: "ton", ton: "ton", tons: "ton", "short ton": "ton", "short tons": "ton", st: "ton",
  load: "load", loads: "load", ld: "load", lds: "load",
  yd: "cu_yd", yds: "cu_yd", cy: "cu_yd", "cu yd": "cu_yd", "cu yds": "cu_yd", "cubic yard": "cu_yd", "cubic yards": "cu_yd", yd3: "cu_yd",
  hr: "hour", hrs: "hour", hour: "hour", hours: "hour",
  mi: "mile", mile: "mile", miles: "mile",
  ea: "each", each: "each",
};

export function unitCode(printed: string | null): string | null {
  if (!printed) return null;
  return UNIT_ALIASES[printed.toLowerCase().replace(/[.\s]+/g, " ").trim()] ?? null;
}

/** Letters and digits only, upper case: "SC-004 512" and "sc004512" are the same ticket number. */
export const normalizeRef = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
const words = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 1));
const num = (n: number) => String(Math.round(n * 1000) / 1000);
const same = (a: number, b: number) => Math.abs(a - b) < 0.0005;

export function crossCheck(reading: TicketReading, t: RecordedTicket): CrossCheck[] {
  const checks: CrossCheck[] = [];
  const cmp = (read: string | null, recorded: string | null, eq: () => boolean): CheckVerdict => (read === null ? "not_read" : recorded === null ? "nothing_to_compare" : eq() ? "matches" : "differs");

  checks.push({
    key: "ticket_number", label: "Paper ticket #", read: reading.ticket_number, recorded: t.externalReference,
    verdict: cmp(reading.ticket_number, t.externalReference, () => normalizeRef(reading.ticket_number!) === normalizeRef(t.externalReference!)),
  });

  const dateVerdict = cmp(reading.date, t.deliveredDate, () => reading.date === t.deliveredDate);
  checks.push({
    key: "date", label: "Date", read: reading.date, recorded: t.deliveredDate, verdict: dateVerdict,
    note: reading.date && reading.date !== t.loadDate ? `The load was planned for ${t.loadDate}.` : undefined,
  });

  checks.push({
    key: "material", label: "Material", read: reading.material, recorded: t.lineDescription,
    // Every word read appears on the order line, or every word of the order line appears in what was read.
    verdict: cmp(reading.material, t.lineDescription, () => {
      const a = words(reading.material!);
      const b = words(t.lineDescription);
      return a.size > 0 && ([...a].every((w) => b.has(w)) || [...b].every((w) => a.has(w)));
    }),
  });

  const readUnit = unitCode(reading.unit);
  const qtyRead = reading.quantity === null ? null : `${num(reading.quantity)}${reading.unit ? ` ${reading.unit}` : ""}`;
  checks.push({
    key: "quantity", label: "Quantity", read: qtyRead, recorded: `${num(t.quantity)} ${t.unitLabel.toLowerCase()}`,
    verdict: reading.quantity === null ? "not_read" : readUnit !== null && readUnit !== t.unitCode ? "differs" : same(reading.quantity, t.quantity) ? (readUnit === null && reading.unit ? "differs" : "matches") : "differs",
    note: reading.quantity !== null && reading.unit && readUnit === null ? `The unit "${reading.unit}" is not one Taviron recognises; nothing is converted.` : readUnit !== null && readUnit !== t.unitCode ? "The unit differs; nothing is converted." : undefined,
  });

  const { gross_weight: g, tare_weight: tw, net_weight: n } = reading;
  if (g !== null || tw !== null || n !== null) {
    const complete = g !== null && tw !== null && n !== null;
    checks.push({
      key: "weights", label: "Scale weights", read: [g !== null && `gross ${num(g)}`, tw !== null && `tare ${num(tw)}`, n !== null && `net ${num(n)}`].filter(Boolean).join(" · ") + (reading.weight_unit ? ` ${reading.weight_unit}` : ""),
      recorded: complete ? `gross − tare = ${num(g! - tw!)}` : null,
      // Arithmetic only: gross minus tare should equal the printed net. No tolerance is assumed beyond rounding.
      verdict: complete ? (Math.abs(g! - tw! - n!) < 0.011 ? "matches" : "differs") : "nothing_to_compare",
      note: complete ? undefined : "Gross, tare and net are needed to check the arithmetic.",
    });
  }

  checks.push({
    key: "truck", label: "Truck", read: reading.truck, recorded: t.truckUnit,
    verdict: cmp(reading.truck, t.truckUnit, () => normalizeRef(reading.truck!) === normalizeRef(t.truckUnit!)),
  });

  if (reading.ticket_number) {
    checks.push({
      key: "duplicate", label: "Used on another ticket", read: reading.ticket_number, recorded: t.otherTicketsWithNumber.length ? t.otherTicketsWithNumber.join(", ") : "none",
      verdict: t.otherTicketsWithNumber.length ? "differs" : "matches",
      note: t.otherTicketsWithNumber.length ? "The same paper ticket number is on another ticket: possibly entered twice." : undefined,
    });
  }
  return checks;
}

// ---------------------------------------------------------------------------
// Evaluation set: fictional tickets rendered to images (scripts/ai/render-ticket-fixtures.mjs)
// ---------------------------------------------------------------------------

export interface TicketEvalCase {
  name: string;
  /** File in tests/fixtures/ai-tickets/. */
  image: string;
  /** What is printed and legible; null where the model must return null. */
  expected: TicketReading;
}

const empty: TicketReading = { readable: true, ticket_number: null, date: null, material: null, quantity: null, unit: null, gross_weight: null, tare_weight: null, net_weight: null, weight_unit: null, truck: null };

export const TICKET_EVAL_CASES: TicketEvalCase[] = [
  {
    name: "scale ticket with gross, tare and net",
    image: "scale-ticket.png",
    expected: { ...empty, ticket_number: "SC-204518", date: "2026-09-14", material: "3/4 Clean Rock", quantity: 21.36, unit: "TN", gross_weight: 36.44, tare_weight: 15.08, net_weight: 21.36, weight_unit: "TN", truck: "T-27" },
  },
  {
    name: "load-count ticket without weights",
    image: "load-ticket.png",
    expected: { ...empty, ticket_number: "88031", date: "2026-09-15", material: "Fill Dirt", quantity: 1, unit: "Load", truck: "112" },
  },
  {
    name: "date smudged: must not be guessed",
    image: "smudged-date.png",
    expected: { ...empty, ticket_number: "SC-204777", material: "Class 5 Base", quantity: 18.9, unit: "TN", gross_weight: 34.12, tare_weight: 15.22, net_weight: 18.9, weight_unit: "TN", truck: "T-31" },
  },
  {
    name: "cubic yards with no ticket number printed",
    image: "no-number.png",
    expected: { ...empty, date: "2026-09-16", material: "Washed Sand", quantity: 12, unit: "yd", truck: "45" },
  },
  {
    name: "not a ticket",
    image: "not-a-ticket.png",
    expected: { ...empty, readable: false },
  },
];

/** Grades an evaluation answer: invented or wrong values are critical; a value left out is not. */
export function gradeReading(raw: unknown, expected: TicketReading): ReadingFinding[] {
  const checked = checkReading(raw);
  if (!checked.ok) return checked.findings;
  const r = checked.value;
  const findings: ReadingFinding[] = [];
  if (r.readable !== expected.readable) findings.push({ rule: "wrong", critical: true, detail: `readable: expected ${expected.readable}.` });
  for (const f of READING_FIELDS) {
    const want = expected[f];
    const got = r[f];
    if (want === null && got !== null) findings.push({ rule: "invented", critical: true, detail: `${f}: nothing legible is printed, but the answer gave ${String(got)}.` });
    else if (want !== null && got === null) findings.push({ rule: "missed", critical: false, detail: `${f}: ${String(want)} is printed but was not read.` });
    else if (want !== null && got !== null) {
      const unitOf = (v: string) => unitCode(v) ?? normalizeRef(v);
      const ok = typeof want === "number" ? same(want, got as number) : f === "unit" || f === "weight_unit" ? unitOf(String(want)) === unitOf(String(got)) : f === "material" ? words(String(got)).size > 0 && [...words(String(want))].every((w) => words(String(got)).has(w)) : normalizeRef(String(want)) === normalizeRef(String(got));
      if (!ok) findings.push({ rule: "wrong", critical: true, detail: `${f}: expected ${String(want)}, got ${String(got)}.` });
    }
  }
  return findings;
}
