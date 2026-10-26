// Hired trucks (B83): the rules the pages show, matching the database (migration 20261120003700). The database stays
// authoritative: it refuses an offer with missing or expired documents and assigns only through a confirmed offer.

export const DOC_KINDS = ["insurance", "w9", "agreement", "registration", "inspection"] as const;
export type DocKind = (typeof DOC_KINDS)[number];

export const DOC_LABELS: Record<DocKind, string> = {
  insurance: "Certificate of insurance",
  w9: "W-9",
  agreement: "Subcontractor agreement",
  registration: "Truck registration",
  inspection: "Truck inspection",
};

/** Kinds kept per truck rather than per hauler. */
export const TRUCK_DOCS: DocKind[] = ["registration", "inspection"];
/** Kinds that must carry an expiry date. */
export const EXPIRY_REQUIRED: DocKind[] = ["insurance", "registration", "inspection"];

export const RATE_UNITS = ["ton", "load", "hour"] as const;
export type RateUnit = (typeof RATE_UNITS)[number];
export const RATE_UNIT_LABELS: Record<RateUnit, string> = { ton: "per ton", load: "per load", hour: "per hour" };

export const OFFER_STATUS: Record<string, { label: string; tone: "amber" | "green" | "gray" | "blue" }> = {
  offered: { label: "Waiting for the hauler", tone: "amber" },
  accepted: { label: "Accepted — confirm it", tone: "blue" },
  declined: { label: "Declined", tone: "gray" },
  withdrawn: { label: "Withdrawn", tone: "gray" },
  confirmed: { label: "Confirmed", tone: "green" },
};

export interface HaulerDoc {
  kind: DocKind;
  truck_id: string | null;
  expires_on: string | null;
  recorded_at: string;
}

export interface DocStatus {
  kind: DocKind;
  truckId: string | null;
  state: "current" | "expired" | "missing";
  expiresOn: string | null;
}

/** The newest record of each kind (per truck for truck documents), checked on `on` (YYYY-MM-DD). */
export function documentStatus(docs: HaulerDoc[], truckIds: string[], on: string): DocStatus[] {
  const newest = (kind: DocKind, truckId: string | null) =>
    docs.filter((d) => d.kind === kind && d.truck_id === truckId).sort((a, b) => b.recorded_at.localeCompare(a.recorded_at))[0];
  const rows: DocStatus[] = [];
  const check = (kind: DocKind, truckId: string | null) => {
    const d = newest(kind, truckId);
    rows.push({ kind, truckId, expiresOn: d?.expires_on ?? null, state: !d ? "missing" : d.expires_on && d.expires_on < on ? "expired" : "current" });
  };
  for (const kind of DOC_KINDS) if (!TRUCK_DOCS.includes(kind)) check(kind, null);
  for (const t of truckIds) for (const kind of TRUCK_DOCS) check(kind, t);
  return rows;
}

/** Whether a hauler's truck may receive an offer on `on`: every hauler document and that truck's documents current. */
export function readyForOffers(status: DocStatus[], truckId: string): boolean {
  return status.filter((s) => s.truckId === null || s.truckId === truckId).every((s) => s.state === "current");
}

export interface PayTicket {
  quantity: number;
  unit_code: string;
}

export interface PayLine {
  /** Verified quantity in the offer's unit, or null when a ticket is in another unit (never converted). */
  quantity: number | null;
  amountCents: number | null;
  note: string | null;
}

/**
 * What a confirmed offer earns: accepted tickets of its assignment times the offered rate, unit for unit. A ticket in
 * another unit leaves the amount open with a note — Taviron never converts units or invents a rate.
 */
export function offerPay(rateCents: number, rateUnit: RateUnit, tickets: PayTicket[]): PayLine {
  if (!tickets.length) return { quantity: null, amountCents: null, note: "No accepted ticket yet." };
  if (tickets.some((t) => t.unit_code !== rateUnit)) return { quantity: null, amountCents: null, note: `A ticket is not in ${rateUnit}s; check it before paying.` };
  const quantity = Math.round(tickets.reduce((n, t) => n + t.quantity, 0) * 1000) / 1000;
  return { quantity, amountCents: Math.round(quantity * rateCents), note: null };
}
