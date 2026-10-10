// Order status rules. Mirrors private.order_transition_allowed,
// private.order_transition_permission and the checks in
// public.set_order_status (supabase/migrations/20261012000100_order_management.sql).
// tests/db/order-management.test.ts proves the two agree.
import type { Permission } from "@/lib/permissions";
import type { OrderStatus } from "@/server/data/types";

export const ORDER_STATUSES: OrderStatus[] = [
  "draft",
  "confirmed",
  "scheduled",
  "dispatched",
  "in_progress",
  "partially_completed",
  "completed",
  "on_hold",
  "canceled",
];

export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  draft: "Draft",
  confirmed: "Confirmed",
  scheduled: "Scheduled",
  dispatched: "Dispatched",
  in_progress: "In progress",
  partially_completed: "Partially completed",
  completed: "Completed",
  on_hold: "On hold",
  canceled: "Canceled",
};

const TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  draft: ["confirmed", "canceled"],
  confirmed: ["scheduled", "on_hold", "canceled"],
  scheduled: ["dispatched", "in_progress", "confirmed", "on_hold", "canceled"],
  dispatched: ["in_progress", "scheduled", "on_hold", "canceled"],
  in_progress: ["completed", "partially_completed", "on_hold"],
  partially_completed: ["completed", "in_progress", "on_hold"],
  on_hold: ["confirmed", "scheduled", "canceled"],
  completed: [],
  canceled: [],
};

/** Orders still being worked on (shown by the "Open" filter). */
export const OPEN_ORDER_STATUSES: OrderStatus[] = ORDER_STATUSES.filter((s) => s !== "completed" && s !== "canceled");

/** Statuses that require a scheduled date. */
const NEEDS_SCHEDULE: OrderStatus[] = ["scheduled", "dispatched", "in_progress"];
/** Statuses in which the scheduled date cannot be removed. */
const KEEPS_SCHEDULE: OrderStatus[] = ["scheduled", "dispatched", "in_progress", "partially_completed"];

export function allowedOrderTransitions(from: OrderStatus): OrderStatus[] {
  return TRANSITIONS[from];
}

export function canTransitionOrder(from: OrderStatus, to: OrderStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Confirming a draft and canceling are office decisions; moving work along is scheduling. */
export function orderTransitionPermission(from: OrderStatus, to: OrderStatus): Permission {
  if (to === "canceled") return "orders.edit";
  if (from === "draft" && to === "confirmed") return "orders.edit";
  return "orders.schedule";
}

export function orderTransitionNeedsReason(to: OrderStatus): boolean {
  return to === "on_hold" || to === "canceled";
}

export function orderTransitionNeedsSchedule(to: OrderStatus): boolean {
  return NEEDS_SCHEDULE.includes(to);
}

export function scheduleRequired(status: OrderStatus): boolean {
  return KEEPS_SCHEDULE.includes(status);
}

export function isFinalOrderStatus(status: OrderStatus): boolean {
  return status === "completed" || status === "canceled";
}

/** Lines, prices, terms and customer can change only on a direct order in Draft. */
export function canEditOrderLines(status: OrderStatus, sourceQuoteId: string | null): boolean {
  return status === "draft" && sourceQuoteId === null;
}

/** Contact, job site, PO, instructions, notes, requested date. */
export function canEditOrderDetails(status: OrderStatus): boolean {
  return !isFinalOrderStatus(status);
}

/** Button label for moving an order from one status to another. */
export function orderTransitionLabel(from: OrderStatus, to: OrderStatus): string {
  switch (to) {
    case "confirmed":
      return from === "draft" ? "Confirm order" : from === "scheduled" ? "Unschedule" : "Release hold";
    case "scheduled":
      return from === "dispatched" ? "Recall to scheduled" : from === "on_hold" ? "Release to scheduled" : "Mark scheduled";
    case "dispatched":
      return "Mark dispatched";
    case "in_progress":
      return from === "partially_completed" ? "Resume work" : "Start work";
    case "partially_completed":
      return "Mark partially completed";
    case "completed":
      return "Mark completed";
    case "on_hold":
      return "Put on hold";
    case "canceled":
      return "Cancel order";
    default:
      return ORDER_STATUS_LABELS[to];
  }
}
