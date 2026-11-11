// "Price to be checked" (financial review M1, owner 2026-11-10; migration 20261120016100). Pure: what the order and
// billing pages say about a price typed on a line without a price-list rate. The database decides whether a check is
// pending (orders.price_check_requested_at without price_checked_at) and refuses billing until it is confirmed.

import { formatBp, formatCents } from "@/lib/money";

export interface PriceCheckOrder {
  price_check_requested_at?: string | null;
  price_check_requested_by?: string | null;
  price_checked_at?: string | null;
  price_checked_by?: string | null;
  price_check_note?: string;
}

export interface PriceCheckLine {
  id?: string;
  line_no: number;
  description: string;
  calc_method: string;
  unit_code: string | null;
  unit_label?: string;
  unit_rate_cents: number | null;
  percent_bp: number | null;
  price_entered_by?: string | null;
}

/** A typed price waits for a person with pricing or billing rights. */
export function priceCheckPending(o: PriceCheckOrder): boolean {
  return Boolean(o.price_check_requested_at) && !o.price_checked_at;
}

/** "Line 2, Rush hauling: $95.00 per load" for each line whose price was typed. */
export function typedPriceLines(lines: PriceCheckLine[]): string[] {
  return lines
    .filter((l) => l.price_entered_by)
    .sort((a, b) => a.line_no - b.line_no)
    .map((l) => {
      const price = l.calc_method === "per_unit"
        ? `${formatCents(l.unit_rate_cents ?? 0)} per ${(l.unit_code || l.unit_label || "unit").toLowerCase()}`
        : `${formatBp(l.percent_bp ?? 0)} of the subtotal`;
      return `Line ${l.line_no}, ${l.description}: ${price}`;
    });
}

/** A typed line billing may correct while confirming (owner 2026-11-10, 20261120016400): per-unit lines only. */
export interface CorrectableLine {
  id: string;
  label: string;
  unit: string;
  rateCents: number;
}

export function correctableLines(lines: PriceCheckLine[]): CorrectableLine[] {
  return lines
    .filter((l) => l.price_entered_by && l.id && l.calc_method === "per_unit")
    .sort((a, b) => a.line_no - b.line_no)
    .map((l) => ({ id: l.id!, label: `Line ${l.line_no}, ${l.description}`, unit: (l.unit_code || l.unit_label || "unit").toLowerCase(), rateCents: l.unit_rate_cents ?? 0 }));
}

/**
 * The corrections to send: lines whose typed price was changed in the dialog (dollars as typed). Null when a price
 * cannot be read; an unchanged line is left out.
 */
export function priceCorrections(lines: CorrectableLine[], typed: Record<string, string>, parse: (s: string) => number | null): Array<{ line_id: string; unit_rate_cents: number }> | null {
  const out: Array<{ line_id: string; unit_rate_cents: number }> = [];
  for (const l of lines) {
    const raw = typed[l.id];
    if (raw === undefined) continue;
    const cents = parse(raw.trim());
    if (cents === null || cents < 0) return null;
    if (cents !== l.rateCents) out.push({ line_id: l.id, unit_rate_cents: cents });
  }
  return out;
}

/**
 * The Command Center's "Price to check" row (financial review M1): typed prices waiting for the office, oldest first,
 * opening the Orders list filtered to them. Null when there are none or they cannot be read.
 */
export function priceCheckRow(pending: Array<{ order_number: string; customer_name: string | null }> | null): {
  kind: string; label: string; count: number; urgent: number; owner: string; example?: string; href: string;
} | null {
  if (!pending?.length) return null;
  const first = pending[0];
  return {
    kind: "price_check",
    label: "Price to check",
    count: pending.length,
    urgent: 0,
    owner: "Office (pricing or billing): confirm the typed price before billing",
    example: `${first.order_number}${first.customer_name ? `, ${first.customer_name}` : ""}`,
    href: "/orders?price=check",
  };
}

/** The latest correction of a typed price in the order's history (audit 'order.price_corrected', 20261120016400). */
export function lastPriceCorrection(audit: Array<{ action: string; occurred_at: string; actor_id: string | null }>): { at: string; actorId: string | null } | null {
  let last: { at: string; actorId: string | null } | null = null;
  for (const e of audit) if (e.action === "order.price_corrected" && (!last || e.occurred_at > last.at)) last = { at: e.occurred_at, actorId: e.actor_id };
  return last;
}

/** Order statuses before any load runs. */
const NOT_RUN = ["draft", "confirmed", "scheduled", "on_hold"];

/**
 * What the person who confirmed a typed price is told next (walkthrough 2026-11-11): "can be billed" only when billing
 * readiness says so; "once the loads are delivered" when no delivery ticket is accepted yet. `billing` is null when the
 * readiness could not be read (the person may not see billing): then only that the price is checked.
 */
export function priceConfirmedMessage(r: { confirmed: boolean; corrected: number }, billing: { readiness: string; tickets_accepted: number } | null, orderStatus?: string | null): string {
  if (!r.confirmed) return "The price was already confirmed.";
  const done = r.corrected ? "Price corrected and confirmed." : "Price checked.";
  // No billing row yet (a draft, or nothing to bill): an order that has not run yet has nothing delivered.
  if (!billing && orderStatus && NOT_RUN.includes(orderStatus)) return `${done} Billing can go ahead once the loads are delivered.`;
  if (!billing) return done;
  if (billing.readiness === "ready") return `${done} The order can be billed.`;
  if (!Number(billing.tickets_accepted)) return `${done} Billing can go ahead once the loads are delivered.`;
  return `${done} Billing can go ahead once its other billing checks pass.`;
}
