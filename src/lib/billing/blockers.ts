// What still keeps one order out of billing, all at once (first-day office walkthrough 2026-11-09): the database picks
// one readiness state at a time, so an office person fixing one thing used to discover the next only afterwards. This
// lists every blocker the billing records already show, each with its own next step. Pure: the page passes the
// counts from billing_order_status and the loads, and decides which buttons the person may use.

import { allowedOrderTransitions } from "@/lib/orders/status";
import type { OrderStatus } from "@/server/data/types";
import { EXCEPTION_LABELS, FULFILLMENT_GAP_LABELS, type ExceptionKind, type FulfillmentGap, type Readiness } from "./rules";

export type BlockerKey = "not_completed" | "missing_tickets" | "unassigned_loads" | "no_tickets" | "tickets_to_check" | "exceptions";

export interface Blocker {
  key: BlockerKey;
  title: string;
  detail: string;
  /** False when the step should wait for another one first (acknowledging before the order is completed). */
  actionable: boolean;
}

export interface BlockerInput {
  readiness: Readiness;
  status: string;
  fulfilled?: boolean;
  fulfillment_gap?: FulfillmentGap | null;
  loads_missing: number;
  tickets_live: number;
  tickets_pending: number;
  exceptions_count: number;
  acknowledgment_id: string | null;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Every reason the order is not billable yet, in the order a person would fix them. `unassignedMissing` is how many of
 * the loads without a ticket never had a truck (only dispatch can fix those); `ackChange` explains why an earlier
 * acknowledgement no longer applies (see acknowledgementChange).
 */
export function billingBlockers(o: BlockerInput, extra: { unassignedMissing?: number; ackChange?: string | null } = {}): Blocker[] {
  if (o.readiness === "ready" || o.readiness === "handed_off") return [];
  const out: Blocker[] = [];
  const unassigned = Math.min(extra.unassignedMissing ?? 0, o.loads_missing);
  const assigned = o.loads_missing - unassigned;
  if (assigned > 0) {
    out.push({
      key: "missing_tickets",
      actionable: true,
      title: `${plural(assigned, "delivered load")} without a delivery ticket`,
      detail: "Enter each ticket from the paper copy (Enter ticket, under Loads below), or cancel the load if it did not run.",
    });
  }
  if (unassigned > 0) {
    out.push({
      key: "unassigned_loads",
      actionable: true,
      title: `${plural(unassigned, "load")} never assigned a truck`,
      detail: "Dispatch assigns the truck and driver that ran it (or cancels the load if it did not run); then its ticket can be entered.",
    });
  }
  if (o.loads_missing === 0 && o.tickets_live === 0 && o.status === "completed") {
    out.push({ key: "no_tickets", actionable: true, title: "No delivery tickets", detail: "Enter the tickets for its loads (plan the loads on the dispatch board first if none exist)." });
  }
  if (o.tickets_pending > 0) {
    out.push({
      key: "tickets_to_check",
      actionable: true,
      title: `${plural(o.tickets_pending, "ticket")} not accepted yet`,
      detail: "Open each ticket, compare it with the paper copy, then accept, correct or void it.",
    });
  }
  const notCompleted = o.status !== "completed" && !o.fulfilled;
  if (notCompleted) {
    const gap = o.fulfillment_gap ? `: ${FULFILLMENT_GAP_LABELS[o.fulfillment_gap].toLowerCase()}` : "";
    out.push({
      key: "not_completed",
      actionable: true,
      title: "The order is not completed",
      detail: `It is ${o.status.replace(/_/g, " ")}${gap}. Mark it completed when all its work is done. Completing it also compares the delivered quantities with the order, which can add differences to acknowledge.`,
    });
  }
  if (o.exceptions_count > 0 && !o.acknowledgment_id) {
    out.push({
      key: "exceptions",
      actionable: !notCompleted,
      title: `${plural(o.exceptions_count, "difference")} to acknowledge`,
      detail: notCompleted
        ? `${extra.ackChange ? `${extra.ackChange.replace(/ Check them again and acknowledge\.$/, "")} ` : ""}Acknowledge them once the order is completed: completing it compares the delivered quantities with the order and can add differences, which would need a new acknowledgement.`
        : extra.ackChange ?? "Check the differences under Exceptions and acknowledge them with a reason, or correct the tickets.",
    });
  }
  return out;
}

export interface ExceptionLike {
  kind: ExceptionKind;
  load_id: string | null;
  line_id: string | null;
  load_number?: number | null;
  line_no?: number | null;
  expected_quantity: number | string | null;
  actual_quantity: number | string | null;
}

const exKey = (e: ExceptionLike) => `${e.kind}|${e.load_id ?? ""}|${e.line_id ?? ""}`;
const num = (v: number | string | null) => (v === null || v === "" ? null : Number(v));
const where = (e: ExceptionLike) => (e.line_no ? `, line ${e.line_no}` : e.load_number ? `, load ${e.load_number}` : "");

/**
 * Why an acknowledgement stopped counting: the differences it covered are not the ones the order has now. Says what
 * changed (new differences, or different delivered amounts) so it never looks silently undone.
 */
export function acknowledgementChange(acknowledged: ExceptionLike[], current: ExceptionLike[]): string {
  const before = new Map(acknowledged.map((e) => [exKey(e), e]));
  const added = current.filter((e) => !before.has(exKey(e)));
  const changed = current.filter((e) => {
    const b = before.get(exKey(e));
    return b && (num(b.actual_quantity) !== num(e.actual_quantity) || num(b.expected_quantity) !== num(e.expected_quantity));
  });
  const parts: string[] = [];
  if (changed.length) parts.push("The delivered amounts changed since you acknowledged them.");
  if (added.length) parts.push(`New since you acknowledged: ${added.map((e) => `${EXCEPTION_LABELS[e.kind]}${where(e)}`).join("; ")}.`);
  if (!parts.length) parts.push("The differences changed since you acknowledged them.");
  return `${parts.join(" ")} Check them again and acknowledge.`;
}

/**
 * The status steps that complete an order from where it is, following the order status rules (never skipping one):
 * an order in progress is completed directly; a scheduled or dispatched one is started first. Null when it cannot be
 * completed from here (not scheduled yet, on hold, canceled).
 */
export function completionSteps(status: OrderStatus): OrderStatus[] | null {
  if (status === "completed") return [];
  const next = allowedOrderTransitions(status);
  if (next.includes("completed")) return ["completed"];
  if (next.includes("in_progress") && allowedOrderTransitions("in_progress").includes("completed")) return ["in_progress", "completed"];
  return null;
}
