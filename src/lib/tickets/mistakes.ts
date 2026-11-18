// "Mistake on my ticket" (owner decision 2026-11-17, master plan §12 TM1; migration 20261120024720): a driver tells the
// office that a ticket they already sent is wrong. The office corrects the ticket with its own correction flow; the
// driver never edits it. Pure, so the wording is tested without a database.

export const MISTAKE_FIELDS = ["ticket_number", "quantity", "material", "other"] as const;
export type MistakeField = (typeof MISTAKE_FIELDS)[number];

/** What the driver taps ("What is wrong?"). */
export const MISTAKE_FIELD_LABELS: Record<MistakeField, string> = {
  ticket_number: "The ticket number",
  quantity: "The quantity",
  material: "The material",
  other: "Something else",
};

/** The label of the "correct value" box for each choice. */
export const MISTAKE_VALUE_LABELS: Record<MistakeField, string> = {
  ticket_number: "The right ticket number (from the paper ticket)",
  quantity: "The right quantity (from the paper ticket)",
  material: "The right material",
  other: "What it should say (optional)",
};

/** How the office sees it, in one line: "Quantity should be 22.5". */
export function mistakeSummary(field: MistakeField, correctValue: string): string {
  const what = { ticket_number: "Ticket number", quantity: "Quantity", material: "Material", other: "Something else" }[field];
  const value = correctValue.trim();
  return value ? (field === "other" ? `${what}: ${value}` : `${what} should be ${value}`) : `${what} is wrong`;
}

/** A report needs either the correct value or a note (the database checks the same). */
export function mistakeError(field: MistakeField | "", correctValue: string, note: string): string | null {
  if (!field) return "Choose what is wrong.";
  if (!correctValue.trim() && !note.trim()) return field === "other" ? "Say what is wrong in the note." : "Enter what the paper ticket says, or add a note.";
  return null;
}

/** What the driver is told after sending (the photo is optional; a refused photo never undoes the report). */
export function mistakeSentMessage(ticketNumber: string, photo: "none" | "sent" | "failed"): string {
  const base = `Mistake on ticket ${ticketNumber} sent to the office. They check it and correct the ticket.`;
  return photo === "failed" ? `${base} The photo could not be added: show the paper ticket to the office.` : photo === "sent" ? `${base} The photo went with it.` : base;
}
