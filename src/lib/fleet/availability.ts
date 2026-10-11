import { addDays } from "@/lib/dates";

// One view of a vehicle's mechanical availability, derived from the records
// that already decide it: the service status (set only through
// set_equipment_service_status, guarded by the maintenance clearance trigger)
// and open work orders. Nothing here changes a status; driver availability and
// hours of service are separate and not part of it.

export const DOCUMENT_KINDS = {
  registration: "Registration",
  insurance: "Insurance",
  inspection: "Inspection certificate",
  permit: "Permit",
  lease: "Lease agreement",
  title: "Title / ownership",
  other: "Other",
} as const;
export type DocumentKind = keyof typeof DOCUMENT_KINDS;

export const OWNERSHIP = { owned: "Owned", financed: "Financed", leased: "Leased", rented: "Rented" } as const;
export type Ownership = keyof typeof OWNERSHIP;

/** Days before expiry that a vehicle document is flagged. */
export const DOCUMENT_WARNING_DAYS = 30;

export type DocumentState = "expired" | "expiring" | "valid" | "no_expiry";

export function documentState(expiresOn: string | null, today: string): DocumentState {
  if (!expiresOn) return "no_expiry";
  if (expiresOn < today) return "expired";
  if (expiresOn <= addDays(today, DOCUMENT_WARNING_DAYS)) return "expiring";
  return "valid";
}

export interface OpenWorkOrder {
  id: string;
  number: string;
  title: string;
  status: string;
  safety_critical: boolean;
  scheduled_for: string | null;
  clearance_status: string | null;
}

export type AvailabilityState = "inactive" | "awaiting_clearance" | "restricted" | "out_of_service" | "in_shop" | "available";

export interface Availability {
  state: AvailabilityState;
  label: string;
  /** Current blocker or note, in plain words. */
  detail: string;
  /** Dispatch can use it now (mechanically). */
  ready: boolean;
  /** Future shop dates that will affect availability (not yet enforced by Smart Dispatch). */
  upcoming: Array<{ date: string; number: string; title: string }>;
}

const IN_SHOP = new Set(["in_progress", "awaiting_parts"]);

export function vehicleAvailability(
  v: { active: boolean; service_status: "in_service" | "out_of_service"; out_of_service_reason: string; expected_return_date: string | null },
  openWorkOrders: OpenWorkOrder[],
  today: string,
): Availability {
  const upcoming = openWorkOrders
    .filter((w) => w.scheduled_for && w.scheduled_for >= today && !IN_SHOP.has(w.status) && w.status !== "awaiting_inspection")
    .map((w) => ({ date: w.scheduled_for!, number: w.number, title: w.title }))
    .sort((a, b) => a.date.localeCompare(b.date));
  if (!v.active) return { state: "inactive", label: "Inactive", detail: "Deactivated — not part of the working fleet.", ready: false, upcoming };

  const safety = openWorkOrders.filter((w) => w.safety_critical);
  const awaiting = safety.find((w) => w.status === "awaiting_inspection");
  if (awaiting) {
    return { state: "awaiting_clearance", label: "Awaiting clearance", detail: `Repair on ${awaiting.number} is done; it returns to service only after an authorized inspection passes.`, ready: false, upcoming };
  }
  if (safety.length) {
    return { state: "restricted", label: "Safety restricted", detail: `Safety-critical defect on ${safety.map((w) => w.number).join(", ")}. Cleared only through Maintenance.`, ready: false, upcoming };
  }
  if (v.service_status === "out_of_service") {
    const back = v.expected_return_date ? ` Expected back ${v.expected_return_date}.` : "";
    return { state: "out_of_service", label: "Out of service", detail: `${v.out_of_service_reason || "No reason recorded."}${back}`, ready: false, upcoming };
  }
  const shop = openWorkOrders.find((w) => IN_SHOP.has(w.status));
  if (shop) {
    return { state: "in_shop", label: "In service · shop work open", detail: `${shop.number} is ${shop.status.replace("_", " ")}. The truck is still marked in service; check with the shop before dispatching.`, ready: true, upcoming };
  }
  return { state: "available", label: "Available", detail: upcoming.length ? `Shop visit scheduled ${upcoming[0].date} (${upcoming[0].number}).` : "In service, no open restriction.", ready: true, upcoming };
}

/** Show only the last 6 characters of a VIN in lists. */
export function maskVin(vin: string): string {
  if (!vin) return "";
  return vin.length <= 6 ? vin : `…${vin.slice(-6)}`;
}

/** What a vehicle's current documents need: expired / expiring, and kinds not recorded. */
export function documentAttention<T extends { kind: DocumentKind; expires_on: string | null }>(docs: T[], today: string) {
  const expired = docs.filter((d) => documentState(d.expires_on, today) === "expired");
  const expiring = docs.filter((d) => documentState(d.expires_on, today) === "expiring");
  const kinds = new Set(docs.map((d) => d.kind));
  // Registration and insurance are shown as "not recorded" when missing — a reminder, not a rule:
  // which documents are required per vehicle is an open decision (master plan §9 Q12).
  const notRecorded = (["registration", "insurance"] as const).filter((k) => !kinds.has(k));
  return { expired, expiring, notRecorded, label: (k: DocumentKind) => DOCUMENT_KINDS[k] };
}

/**
 * Days out of service within the last `periodDays`, from the status history
 * (and the current status). Only recorded changes count; nothing is estimated.
 */
export function downtimeDays(
  events: Array<{ from_status: string; to_status: string; occurred_at: string }>,
  current: { service_status: string; out_of_service_since: string | null },
  now: Date,
  periodDays: number,
): number {
  const start = now.getTime() - periodDays * 86400_000;
  const ordered = [...events].sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));
  let ms = 0;
  let outFrom: number | null = null;
  for (const e of ordered) {
    const t = Date.parse(e.occurred_at);
    if (e.to_status === "out_of_service") outFrom = t;
    else if (e.to_status === "in_service" && outFrom !== null) {
      ms += Math.max(0, t - Math.max(outFrom, start));
      outFrom = null;
    }
  }
  if (current.service_status === "out_of_service") {
    const from = outFrom ?? (current.out_of_service_since ? Date.parse(current.out_of_service_since) : null);
    if (from !== null) ms += Math.max(0, now.getTime() - Math.max(from, start));
  }
  return Math.round((ms / 86400_000) * 10) / 10;
}
