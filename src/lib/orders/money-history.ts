// Order and quote history without the totals (SEC7, migration 20261120024700): the same redaction as the database's
// public.sales_history, for a demo role preview whose real account has money access. Pure, so it is tested.

type Entry = { action: string; summary: string; details: Record<string, unknown> };

/** The history entries that carry an order or quote total. */
export const MONEY_HISTORY_ACTIONS = new Set(["order.created", "order.created_from_quote", "order.updated", "order.price_check_requested", "order.price_checked", "order.price_corrected", "quote.created", "quote.updated"]);

/** ": total 610.00" out of the summary, total_cents and the like out of the details; other entries as they are. */
export function redactHistoryEntry<T extends Entry>(e: T): T {
  if (!MONEY_HISTORY_ACTIONS.has(e.action)) return e;
  const summary = e.summary.replace(/[:,]\s*total\s+-?[0-9][0-9,]*\.[0-9]{2}/g, "");
  let details = e.details;
  if (details && typeof details === "object" && !Array.isArray(details)) {
    const d = { ...details };
    for (const k of ["total_cents", "subtotal_cents", "tax_cents", "total_from", "total_to"]) delete d[k];
    if (d.changes && typeof d.changes === "object" && !Array.isArray(d.changes)) {
      const c = { ...(d.changes as Record<string, unknown>) };
      for (const k of ["total_cents", "subtotal_cents", "tax_cents", "discount_cents", "taxable_cents"]) delete c[k];
      d.changes = c;
    }
    details = d;
  }
  return { ...e, summary, details };
}
