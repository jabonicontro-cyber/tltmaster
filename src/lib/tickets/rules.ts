// Delivery ticket rules shared by the UI. The database is authoritative
// (private.prepare_ticket, private.unit_requires_whole); tests/db/tickets.test.ts
// checks the shared parts agree.

export const TICKET_STATUSES = ["submitted", "needs_review", "accepted", "voided", "superseded"] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const TICKET_STATUS_LABELS: Record<TicketStatus, string> = {
  submitted: "Submitted",
  needs_review: "Needs review",
  accepted: "Accepted",
  voided: "Voided",
  superseded: "Superseded",
};

/** Units counted in whole numbers. */
export const WHOLE_NUMBER_UNITS = ["load", "each"] as const;

export function unitRequiresWhole(code: string): boolean {
  return (WHOLE_NUMBER_UNITS as readonly string[]).includes(code);
}

/** Reasons the database attaches to a ticket that needs office review. */
export const REVIEW_REASON_LABELS: Record<string, string> = {
  unit_differs_from_order_line: "Unit differs from the order line's unit (no conversion is made — check the quantity).",
  delivered_on_other_day: "Delivered on a different day than the load was planned.",
  equipment_differs_from_assignment: "Truck, trailer or driver differs from the dispatch assignment.",
  missing_external_reference: "No paper / scale ticket number was entered.",
  additional_ticket_for_load: "Another ticket already exists for this load.",
  duplicate_external_reference: "The paper / scale ticket number is already used on another ticket.",
};

export function reviewReasonLabel(code: string): string {
  return REVIEW_REASON_LABELS[code] ?? code;
}

/**
 * Validate a delivered quantity typed by a person. Returns an error message,
 * or null when valid. Never defaults or converts.
 */
export function quantityError(quantity: string, unitCode: string | null | undefined): string | null {
  const q = quantity.trim();
  if (!q) return "Enter the delivered quantity.";
  if (!/^\d{1,6}(\.\d{1,3})?$/.test(q)) return "Enter a number greater than 0 with at most 3 decimals.";
  if (Number(q) <= 0) return "Must be greater than 0.";
  if (!unitCode) return null;
  if (unitRequiresWhole(unitCode) && !/^\d+(\.0{1,3})?$/.test(q)) return `Quantities in ${unitCode} must be whole numbers.`;
  return null;
}

/** Statuses that count as a live ticket for a load. */
export function isLiveTicket(status: TicketStatus): boolean {
  return status !== "voided" && status !== "superseded";
}
