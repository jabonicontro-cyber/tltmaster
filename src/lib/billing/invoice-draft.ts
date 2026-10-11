// Invoice preparation (N14): a draft computed from what was actually
// delivered, priced with the order's approved prices. It is never stored,
// never issued and never sent: the separate states are
//   delivered → verified (accepted tickets) → billing ready → invoice draft
//   (this file) → handed off to accounting (billing handoff batch) →
//   invoice issued / paid (in the accounting system; not tracked here).
// Amounts use the same calculation as quotes and orders (src/lib/quotes/calc).

import { calculateQuote, type CalcLine, type CalcMethod, type ChargeKind } from "@/lib/quotes/calc";
import type { Readiness } from "./rules";

export interface DraftOrderLine {
  id: string;
  line_no: number;
  kind: ChargeKind;
  calc_method: CalcMethod;
  description: string;
  unit_code: string | null;
  quantity: number | string | null;
  unit_rate_cents: number | null;
  percent_bp: number | null;
  taxable: boolean;
  amount_cents: number;
}

export interface DraftTicket {
  order_line_id: string | null;
  status: string;
  quantity: number | string | null;
  unit_code: string | null;
}

/** Where a draft line's quantity comes from. */
export type QuantityBasis =
  | "delivered" // accepted tickets for this line, in the line's unit
  | "ordered_no_tickets" // no ticket references this line: the ordered quantity, to confirm
  | "ordered_fixed" // a discount or other fixed line: as ordered
  | "percentage"; // a percentage of the draft subtotal

export interface DraftLine {
  lineId: string;
  lineNo: number;
  description: string;
  unitCode: string | null;
  basis: QuantityBasis;
  /** Quantity on the draft (null for percentage lines). */
  quantity: number | null;
  orderedQuantity: number | null;
  rateCents: number | null;
  percentBp: number | null;
  amountCents: number;
  orderedAmountCents: number;
  /** Things a person must check before this line is invoiced. */
  warnings: string[];
}

export interface InvoiceDraft {
  /** Final draft only when billing readiness is "ready" (or already handed off); otherwise a preview. */
  stage: "draft" | "preview";
  lines: DraftLine[];
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  totalCents: number;
  orderedTotalCents: number;
  /** Draft total minus the order's total (ordered quantities). */
  differenceCents: number;
  /** Reasons the draft cannot be relied on yet (empty when stage = draft and no line needs confirmation). */
  blockers: string[];
  needsConfirmation: number;
}

const milli = (q: number | string | null): number | null => {
  if (q === null || q === "") return null;
  const n = Number(q);
  return Number.isFinite(n) ? Math.round(n * 1000) : null;
};

export function buildInvoiceDraft(input: {
  lines: DraftOrderLine[];
  tickets: DraftTicket[];
  taxRateBp: number;
  orderTotalCents: number;
  readiness: Readiness | null;
}): InvoiceDraft {
  const lines = [...input.lines].sort((a, b) => a.line_no - b.line_no);
  const byLine = new Map<string, DraftTicket[]>();
  for (const t of input.tickets) {
    if (!t.order_line_id || t.status === "voided" || t.status === "superseded") continue;
    byLine.set(t.order_line_id, [...(byLine.get(t.order_line_id) ?? []), t]);
  }

  const prepared = lines.map((l) => {
    const warnings: string[] = [];
    let basis: QuantityBasis;
    let qMilli: number | null = milli(l.quantity);
    if (l.calc_method === "percent_of_subtotal") {
      basis = "percentage";
      qMilli = null;
    } else if (l.kind === "discount") {
      basis = "ordered_fixed";
    } else {
      const ts = byLine.get(l.id) ?? [];
      if (ts.length === 0) {
        basis = "ordered_no_tickets";
        warnings.push("No delivery ticket references this line, so the ordered quantity is used. Confirm it before invoicing.");
      } else {
        basis = "delivered";
        const accepted = ts.filter((t) => t.status === "accepted" && t.unit_code === l.unit_code);
        qMilli = accepted.reduce((sum, t) => sum + (milli(t.quantity) ?? 0), 0);
        const pending = ts.filter((t) => t.status === "submitted" || t.status === "needs_review").length;
        const otherUnit = ts.filter((t) => t.status === "accepted" && t.unit_code !== l.unit_code).length;
        if (pending > 0) warnings.push(`${pending} ticket${pending === 1 ? " is" : "s are"} not accepted yet and ${pending === 1 ? "is" : "are"} not counted.`);
        if (otherUnit > 0) warnings.push(`${otherUnit} accepted ticket${otherUnit === 1 ? " is" : "s are"} in another unit and not counted.`);
      }
      if (!l.unit_rate_cents) warnings.push("The line has no price (zero rate).");
    }
    const calc: CalcLine = { kind: l.kind, calcMethod: l.calc_method, quantityMilli: qMilli, rateCents: l.unit_rate_cents, percentBp: l.percent_bp, taxable: l.taxable };
    return { l, basis, qMilli, warnings, calc };
  });

  const totals = calculateQuote(prepared.map((p) => p.calc), input.taxRateBp);
  const draftLines: DraftLine[] = prepared.map((p, i) => ({
    lineId: p.l.id,
    lineNo: p.l.line_no,
    description: p.l.description,
    unitCode: p.l.unit_code,
    basis: p.basis,
    quantity: p.qMilli === null ? null : p.qMilli / 1000,
    orderedQuantity: p.basis === "percentage" ? null : (milli(p.l.quantity) ?? 0) / 1000,
    rateCents: p.l.unit_rate_cents,
    percentBp: p.l.percent_bp,
    amountCents: totals.lineAmounts[i],
    orderedAmountCents: p.l.amount_cents,
    warnings: p.warnings,
  }));

  const blockers: string[] = [];
  if (input.readiness === null) blockers.push("Billing readiness could not be determined.");
  else if (input.readiness !== "ready" && input.readiness !== "handed_off") blockers.push("The order is not ready for billing yet; this is a preview of what has been verified so far.");
  const needsConfirmation = draftLines.filter((l) => l.warnings.length > 0).length;

  return {
    stage: input.readiness === "ready" || input.readiness === "handed_off" ? "draft" : "preview",
    lines: draftLines,
    subtotalCents: totals.subtotalCents,
    discountCents: totals.discountCents,
    taxCents: totals.taxCents,
    totalCents: totals.totalCents,
    orderedTotalCents: input.orderTotalCents,
    differenceCents: totals.totalCents - input.orderTotalCents,
    blockers,
    needsConfirmation,
  };
}
