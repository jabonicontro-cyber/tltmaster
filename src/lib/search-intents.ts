/**
 * Search that understands intent (B124): everyday phrases ("overdue invoices", "trucks down", "late loads") jump to the
 * page that answers them. Deterministic matching on the person's words; only pages they may open are offered.
 */
import type { Permission } from "@/lib/permissions";
import type { SearchHit } from "@/lib/search";

interface Intent { id: string; words: string[][]; title: string; detail: string; href: string; anyOf: Permission[] }

// Each inner list is one way of asking: every word in it must appear (as the start of a word) in the query.
const INTENTS: Intent[] = [
  { id: "overdue", words: [["overdue"], ["past", "due"], ["late", "invoice"], ["who", "owes"], ["owe"]], title: "Overdue invoices", detail: "Invoices past their terms, and what each customer owes", href: "/billing/invoices?view=overdue", anyOf: ["billing.view"] },
  { id: "unbilled", words: [["unbilled"], ["not", "billed"], ["missed", "revenue"], ["revenue", "check"], ["leak"]], title: "Revenue check", detail: "Delivered work not billed, short billing, voided invoices", href: "/billing/leaks", anyOf: ["billing.view"] },
  { id: "ready", words: [["ready", "bill"], ["to", "invoice"], ["hand", "off"]], title: "Ready to bill", detail: "Delivered, documented and reviewed orders", href: "/billing?view=ready", anyOf: ["billing.view"] },
  { id: "down", words: [["trucks", "down"], ["out", "service"], ["broken"], ["breakdown"]], title: "Trucks out of service", detail: "Units that cannot run, with expected return", href: "/fleet/trucks?status=out_of_service", anyOf: ["fleet.view"] },
  { id: "unassigned", words: [["unassigned"], ["no", "truck"], ["without", "truck"], ["need", "truck"], ["late", "load"], ["dispatch"]], title: "Dispatch board", detail: "Today's loads, proposals and uncovered work", href: "/dispatch", anyOf: ["dispatch.view"] },
  { id: "plan", words: [["plan", "tomorrow"], ["plan", "day"], ["tomorrow"]], title: "Plan the day", detail: "Assign a whole day at once", href: "/dispatch/plan", anyOf: ["dispatch.view"] },
  { id: "review", words: [["review", "ticket"], ["tickets", "review"], ["pending", "ticket"]], title: "Tickets to review", detail: "Submitted tickets waiting for the office", href: "/tickets", anyOf: ["tickets.view"] },
  { id: "wait", words: [["wait"], ["detention"], ["slow", "site"]], title: "Wait times", detail: "Where trucks wait, slowest places first", href: "/reports/wait-times", anyOf: ["dispatch.view", "billing.view"] },
  { id: "where", words: [["where", "truck"], ["location"], ["gps"], ["hours", "service"], ["hos"]], title: "Locations and hours", detail: "Truck positions and drivers' hours", href: "/fleet/locations", anyOf: ["fleet.view"] },
  { id: "customers", words: [["ordering", "less"], ["customer", "health"], ["paying", "slow"], ["cash", "forecast"], ["cash"]], title: "Customer insights", detail: "Customers ordering less or paying slower; cash expected", href: "/reports/customers", anyOf: ["billing.view", "orders.view"] },
  { id: "whatif", words: [["what", "if"], ["add", "truck"], ["raise", "rate"], ["rate", "change"]], title: "What if", detail: "Try adding trucks or changing a customer's rates", href: "/reports/what-if", anyOf: ["billing.view"] },
  { id: "profit", words: [["profit"], ["margin"], ["revenue"]], title: "Reports", detail: "Delivered value, profit per load and per customer", href: "/reports", anyOf: ["billing.view", "tickets.view", "dispatch.view", "fleet.view"] },
  { id: "briefing", words: [["today"], ["briefing"], ["what", "do", "first"], ["morning"]], title: "Morning briefing", detail: "What needs you today, ranked", href: "/briefing", anyOf: ["dispatch.view", "billing.view"] },
  { id: "shop", words: [["repair"], ["work", "order"], ["shop"], ["parts"], ["maintenance"]], title: "Maintenance", detail: "Open work orders, shop insights and parts", href: "/maintenance", anyOf: ["maintenance.view"] },
  { id: "time-off", words: [["time", "off"], ["vacation"], ["pto"]], title: "Time off", detail: "Requests and balances", href: "/time-off", anyOf: ["time_off.approve", "time_off.balances"] },
  { id: "schedule", words: [["schedule"], ["shift"], ["who", "working"]], title: "Schedule", detail: "Who works when", href: "/schedule", anyOf: ["schedules.manage"] },
];

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);

/** Pages that answer the query, best first (at most 3), for a person with these permissions. */
export function intentHits(query: string, can: (p: Permission) => boolean): SearchHit[] {
  const q = norm(query);
  if (!q.length) return [];
  const has = (w: string) => q.some((t) => t.startsWith(w) || (t.length >= 4 && w.startsWith(t)));
  const scored: Array<{ i: Intent; score: number }> = [];
  for (const i of INTENTS) {
    if (!i.anyOf.some(can)) continue;
    const best = Math.max(0, ...i.words.filter((ws) => ws.every(has)).map((ws) => ws.length));
    if (best > 0) scored.push({ i, score: best });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, 3).map(({ i }) => ({ id: `goto-${i.id}`, title: i.title, detail: i.detail, href: i.href }));
}
