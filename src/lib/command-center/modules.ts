// Command Center and workflow modules (MOD1, docs/MODULES.md §4): items, counts and cards of a switched-off module are
// left out, so nothing points at an area the company does not use. Safety items (equipment out of service, driver
// reports) are never tied to a module. Pure, so it is tested without a database.

import type { ModuleKey } from "@/lib/modules";
import type { CommandSummary, ExceptionItem, ExceptionKind } from "./rules";

/** The module each kind of attention item belongs to (null: always shown). */
export const KIND_MODULE: Record<ExceptionKind, ModuleKey | null> = {
  urgent_order: "orders",
  order_unscheduled: "dispatch",
  unassigned_load: "dispatch",
  assignment_problem: "dispatch",
  missing_ticket: "tickets",
  ticket_review: "tickets",
  billing_blocked: "billing",
  equipment_out_of_service: null,
  delay_report: null,
  equipment_report: null,
};

export const kindShown = (kind: ExceptionKind, off: readonly string[]): boolean => {
  const m = KIND_MODULE[kind];
  return m === null || !off.includes(m);
};

/** Overview counts without the switched-off modules' kinds and cards (a hidden card is null, as "not available"). */
export function summaryForModules(s: CommandSummary, off: readonly string[]): CommandSummary {
  if (!off.length) return s;
  const by_kind = { ...s.by_kind };
  const urgent_by_kind = s.urgent_by_kind ? { ...s.urgent_by_kind } : s.urgent_by_kind;
  let total = s.exceptions.total;
  let urgent = s.exceptions.urgent;
  for (const k of Object.keys(KIND_MODULE) as ExceptionKind[]) {
    if (kindShown(k, off)) continue;
    total -= by_kind[k] ?? 0;
    delete by_kind[k];
    if (urgent_by_kind) {
      urgent -= urgent_by_kind[k] ?? 0;
      delete urgent_by_kind[k];
    }
  }
  const on = (m: ModuleKey) => !off.includes(m);
  return {
    ...s,
    by_kind,
    urgent_by_kind,
    exceptions: { ...s.exceptions, total: Math.max(0, total), urgent: Math.max(0, urgent) },
    urgent_orders: on("orders") ? s.urgent_orders : null,
    orders_today: on("orders") ? s.orders_today : null,
    orders_unscheduled: on("dispatch") ? s.orders_unscheduled : null,
    loads_today: on("dispatch") ? s.loads_today : null,
    loads_today_assigned: on("dispatch") ? s.loads_today_assigned : null,
    unassigned_loads: on("dispatch") ? s.unassigned_loads : null,
    assignment_problems: on("dispatch") ? s.assignment_problems : null,
    missing_tickets: on("tickets") ? s.missing_tickets : null,
    tickets_to_review: on("tickets") ? s.tickets_to_review : null,
    billing_blocked: on("billing") ? s.billing_blocked : null,
    billing_ready: on("billing") ? s.billing_ready : null,
  };
}

/** A queue page without the switched-off modules' items. */
export function itemsForModules<T extends { total: number; items: ExceptionItem[] }>(page: T, off: readonly string[]): T {
  if (!off.length) return page;
  const items = page.items.filter((i) => kindShown(i.kind, off));
  return { ...page, items, total: Math.max(0, page.total - (page.items.length - items.length)) };
}
