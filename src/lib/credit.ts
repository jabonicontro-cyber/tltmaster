// Credit holds (B128): the wording shared by orders, dispatch and the customer page.

export type HoldReason = "manual" | "overdue" | "over_limit";

const REASON: Record<HoldReason, string> = { manual: "put on hold by billing", overdue: "invoices past due", over_limit: "over the credit limit" };

/** One line for people: "on credit hold (invoices past due) — Two invoices 60 days late". */
export function holdSummary(h: { reasons: HoldReason[]; note: string }): string {
  return `on credit hold (${h.reasons.map((r) => REASON[r]).join(", ")})${h.note && h.reasons.includes("manual") ? `: ${h.note}` : ""}`;
}
