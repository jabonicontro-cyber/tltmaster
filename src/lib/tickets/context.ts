// Delivery context for a ticket under review: how much of the order line is
// already verified, what is waiting, and what this ticket would make it. Same
// unit only (no conversions — like billing). Quantities have at most 3 decimals,
// so they are added as integer thousandths.

import type { TicketStatus } from "./rules";

const toMilli = (v: number | string) => Math.round(Number(v) * 1000);
const fromMilli = (m: number) => (m / 1000).toFixed(3).replace(/\.?0+$/, "");

export interface LineTicket {
  id: string;
  status: TicketStatus;
  quantity: number | string;
  unit_code: string;
}

export interface LineProgress {
  unit: string;
  ordered: string;
  /** Accepted (verified) tickets on the line, other than this one. */
  verifiedOthers: string;
  /** Submitted or flagged tickets on the line, other than this one. */
  pendingOthers: string;
  /** This ticket, when it is in the line's unit. */
  thisTicket: string | null;
  /** Verified others + this ticket. */
  afterThis: string;
  /** Ordered − (verified others + this); negative = over the order. */
  remainingAfterThis: string;
  over: boolean;
  /** Tickets on the line in another unit (never added). */
  otherUnitTickets: number;
}

export function lineProgress(line: { unit_code: string; quantity: number | string }, tickets: LineTicket[], currentId: string): LineProgress {
  const sameUnit = tickets.filter((t) => t.unit_code === line.unit_code && t.status !== "voided" && t.status !== "superseded");
  const others = sameUnit.filter((t) => t.id !== currentId);
  const current = sameUnit.find((t) => t.id === currentId);
  const verified = others.filter((t) => t.status === "accepted").reduce((s, t) => s + toMilli(t.quantity), 0);
  const pending = others.filter((t) => t.status === "submitted" || t.status === "needs_review").reduce((s, t) => s + toMilli(t.quantity), 0);
  const mine = current ? toMilli(current.quantity) : 0;
  const ordered = toMilli(line.quantity);
  const after = verified + mine;
  return {
    unit: line.unit_code,
    ordered: fromMilli(ordered),
    verifiedOthers: fromMilli(verified),
    pendingOthers: fromMilli(pending),
    thisTicket: current ? fromMilli(mine) : null,
    afterThis: fromMilli(after),
    remainingAfterThis: fromMilli(ordered - after),
    over: after > ordered,
    otherUnitTickets: tickets.filter((t) => t.unit_code !== line.unit_code && t.status !== "voided" && t.status !== "superseded").length,
  };
}
