import { quantityError } from "@/lib/tickets/rules";

// The driver's ticket form (src/components/driver/driver-ticket-form.tsx): what it checks before sending, which error
// the driver is taken to first, and the order line's unit chosen for them. Pure, so it is unit tested.

export type TicketField = "line" | "quantity" | "unit" | "date" | "time" | "photos";
export type TicketErrors = Partial<Record<TicketField, string>>;

/** Top to bottom, as the fields appear on the form: a failed send goes to the first one with an error. */
export const TICKET_FIELD_ORDER: readonly TicketField[] = ["line", "quantity", "unit", "date", "time", "photos"];

/** The element a failed send scrolls to and focuses, per field. */
export const TICKET_FIELD_IDS: Record<TicketField, string> = {
  line: "d-line", quantity: "d-qty", unit: "d-unit", date: "d-date", time: "d-time", photos: "d-photos",
};

export function ticketFormErrors(v: { lineId: string; quantity: string; unit: string; time: string; photos: { busy: boolean; failed: boolean } }): TicketErrors {
  const e: TicketErrors = {};
  if (!v.lineId) e.line = "Choose what you delivered.";
  if (!v.unit) e.unit = "Tap the unit on the paper ticket.";
  const q = v.quantity.trim() ? quantityError(v.quantity, v.unit || "ton") : "Enter the quantity.";
  if (q) e.quantity = q;
  if (!v.time) e.time = "Enter the delivery time.";
  if (v.photos.busy) e.photos = "Wait until the photo has uploaded.";
  else if (v.photos.failed) e.photos = "A photo did not upload. Tap Retry, or remove it.";
  return e;
}

export function firstTicketError(errors: TicketErrors): TicketField | null {
  return TICKET_FIELD_ORDER.find((f) => errors[f]) ?? null;
}

/** The errors without these fields' (a field the driver just changed); the same object when nothing changes. */
export function clearTicketErrors(errors: TicketErrors, ...fields: TicketField[]): TicketErrors {
  if (!fields.some((f) => errors[f])) return errors;
  const next = { ...errors };
  for (const f of fields) delete next[f];
  return next;
}

/** The server names fields as the action does (orderLineId, unitCode...); the form shows them under its own fields. */
const SERVER_FIELDS: Record<string, TicketField> = {
  orderLineId: "line", quantity: "quantity", unitCode: "unit", deliveredDate: "date", deliveredTime: "time", photoIds: "photos",
};
export function serverTicketErrors(fieldErrors?: Record<string, string>): TicketErrors {
  const e: TicketErrors = {};
  for (const [k, msg] of Object.entries(fieldErrors ?? {})) {
    const f = SERVER_FIELDS[k] ?? (TICKET_FIELD_ORDER.includes(k as TicketField) ? (k as TicketField) : null);
    if (f && !e[f]) e[f] = msg;
  }
  return e;
}

/**
 * The unit chosen before the driver taps one (UX6: the order's unit preselected): the order line's unit when the
 * company offers it, otherwise none. The form marks it "Order unit" and says to change it if the paper ticket differs.
 */
export function preselectedUnit(line: { unit_code: string } | undefined, units: Array<{ code: string }>): string {
  return line && units.some((u) => u.code === line.unit_code) ? line.unit_code : "";
}
