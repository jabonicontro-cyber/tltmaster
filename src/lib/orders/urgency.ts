// Urgent orders: states and who can move them. The database enforces the same
// rules (public.update_order_urgency); this file only explains them and decides
// which buttons to show. Flagging an order never assigns a truck, changes an
// assignment or promises a delivery time.

import type { Permission } from "@/lib/permissions";

export const URGENCY_STATES = [
  "awaiting_acknowledgement",
  "acknowledged",
  "evaluating",
  "waiting_for_information",
  "blocked",
  "assigned",
  "resolved",
  "canceled",
] as const;
export type UrgencyState = (typeof URGENCY_STATES)[number];

export const URGENCY_LABELS: Record<UrgencyState, string> = {
  awaiting_acknowledgement: "Awaiting acknowledgement",
  acknowledged: "Acknowledged by dispatch",
  evaluating: "Dispatch is evaluating",
  waiting_for_information: "Waiting for information",
  blocked: "Blocked",
  assigned: "Truck assigned",
  resolved: "Resolved",
  canceled: "Flag withdrawn",
};

/** Who handles the next step in each open state. */
export const URGENCY_NEXT_OWNER: Record<UrgencyState, string> = {
  awaiting_acknowledgement: "Dispatch: acknowledge it",
  acknowledged: "Dispatch: evaluate and assign",
  evaluating: "Dispatch: decide and assign",
  waiting_for_information: "Office: provide the missing information",
  blocked: "Dispatch and office: remove the blocker",
  assigned: "Dispatch: resolve once delivered or confirmed",
  resolved: "Nobody — closed",
  canceled: "Nobody — closed",
};

export const OPEN_URGENCY_STATES: UrgencyState[] = ["awaiting_acknowledgement", "acknowledged", "evaluating", "waiting_for_information", "blocked", "assigned"];

/** States that need a note (what is blocking, missing, or how it ended). */
export const NOTE_REQUIRED: UrgencyState[] = ["blocked", "waiting_for_information", "resolved", "canceled"];

export interface UrgencyAction {
  state: UrgencyState;
  label: string;
}

/** The moves the caller may make from the current state (mirrors the SQL permission rules). */
export function urgencyActions(current: UrgencyState, can: (p: Permission) => boolean): UrgencyAction[] {
  if (current === "resolved" || current === "canceled") return [];
  const dispatch = can("dispatch.edit");
  const office = can("orders.edit");
  const out: UrgencyAction[] = [];
  if (dispatch) {
    if (current === "awaiting_acknowledgement") out.push({ state: "acknowledged", label: "Acknowledge" });
    for (const [state, label] of [
      ["evaluating", "Evaluating"],
      ["waiting_for_information", "Waiting for information"],
      ["blocked", "Blocked"],
      ["assigned", "Truck assigned"],
    ] as const) {
      if (state !== current) out.push({ state, label });
    }
  }
  if (dispatch || office) out.push({ state: "resolved", label: "Resolve" });
  if (office) out.push({ state: "canceled", label: "Withdraw flag" });
  return out;
}

export const URGENCY_REASONS: Record<string, string> = {
  urgent_awaiting_acknowledgement: "Flagged urgent by the office; dispatch has not acknowledged it.",
  urgent_acknowledged: "Dispatch acknowledged it; not assigned yet.",
  urgent_evaluating: "Dispatch is evaluating trucks and drivers.",
  urgent_waiting_for_information: "Waiting for information before it can be planned.",
  urgent_blocked: "Blocked — see the note.",
  urgent_assigned: "A truck is assigned; resolve it once delivered or confirmed.",
  urgent_ack_overdue: "Not acknowledged within the company's escalation time.",
  urgent_deadline_passed: "The needed-by time has passed.",
};
