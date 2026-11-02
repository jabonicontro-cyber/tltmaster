/**
 * Owner morning briefing (B116): the day's signals turned into a short, ranked list of things to do, each with the
 * place that fixes it. Deterministic rules, figures from records only; nothing is done automatically. A signal the
 * viewer may not see is null and produces nothing.
 */

export interface BriefingSignals {
  urgentOrders: number | null;
  loadsTodayUnassigned: number | null;
  assignmentProblems: number | null;
  trucksDown: number | null;
  driverReports: number | null;
  ticketsToReview: number | null;
  missingTickets: number | null;
  billingReady: number | null;
  billingBlocked: number | null;
  overdueInvoices: { count: number; cents: number } | null;
  revenueToCheck: { count: number; cents: number } | null;
  tomorrowUnassigned: number | null;
  longWaitsYesterday: number | null;
}

export type ActionTone = "critical" | "warn" | "info";

export interface BriefingAction {
  key: string;
  title: string;
  detail: string;
  href: string;
  cta: string;
  tone: ActionTone;
  /** Higher first. */
  weight: number;
}

const n = (x: number | null | undefined) => (x ?? 0) > 0;
const plural = (c: number, one: string, many = `${one}s`) => `${c} ${c === 1 ? one : many}`;
const money = (cents: number) => `$${Math.round(cents / 100).toLocaleString("en-US")}`;

/** Every action the signals call for, most important first. */
export function briefingActions(s: BriefingSignals): BriefingAction[] {
  const out: BriefingAction[] = [];
  if (n(s.urgentOrders)) out.push({ key: "urgent", tone: "critical", weight: 100, title: `${plural(s.urgentOrders!, "urgent order")} waiting`, detail: "A customer flagged a change or a deadline. Acknowledge it so dispatch acts on it.", href: "/command-center?kind=urgent_order#attention", cta: "Open urgent orders" });
  if (n(s.loadsTodayUnassigned)) out.push({ key: "unassigned", tone: "critical", weight: 90, title: `${plural(s.loadsTodayUnassigned!, "load")} today without a truck`, detail: "Smart Dispatch has proposals ready for most of them.", href: "/dispatch", cta: "Assign on the board" });
  if (n(s.assignmentProblems)) out.push({ key: "problems", tone: "critical", weight: 85, title: `${plural(s.assignmentProblems!, "assignment")} that would now be refused`, detail: "A truck, trailer or driver no longer qualifies (repair, expired document, time off).", href: "/command-center?kind=assignment_problem#attention", cta: "Fix assignments" });
  if (n(s.overdueInvoices?.count)) out.push({ key: "overdue", tone: "warn", weight: 70 + Math.min(15, Math.floor(s.overdueInvoices!.cents / 500000)), title: `${money(s.overdueInvoices!.cents)} overdue on ${plural(s.overdueInvoices!.count, "invoice")}`, detail: "Customers past their payment terms.", href: "/billing/invoices?view=overdue", cta: "See who owes" });
  if (n(s.revenueToCheck?.count)) out.push({ key: "revenue", tone: "warn", weight: 65 + Math.min(15, Math.floor(s.revenueToCheck!.cents / 500000)), title: `About ${money(s.revenueToCheck!.cents)} possibly not billed`, detail: `${plural(s.revenueToCheck!.count, "finding")}: delivered work not handed off, short billing or voided invoices.`, href: "/billing/leaks", cta: "Check revenue" });
  if (n(s.billingReady)) out.push({ key: "ready", tone: "info", weight: 60, title: `${plural(s.billingReady!, "order")} ready to bill`, detail: "Delivered, documented and reviewed.", href: "/billing?view=ready", cta: "Hand off for billing" });
  if (n(s.missingTickets)) out.push({ key: "missing", tone: "warn", weight: 55, title: `${plural(s.missingTickets!, "delivered load")} without a ticket`, detail: "Billing waits until each load has its ticket.", href: "/command-center?kind=missing_ticket#attention", cta: "Chase tickets" });
  if (n(s.ticketsToReview)) out.push({ key: "review", tone: "info", weight: 50, title: `${plural(s.ticketsToReview!, "ticket")} to review`, detail: "Accepted tickets move orders toward billing.", href: "/tickets", cta: "Review tickets" });
  if (n(s.trucksDown)) out.push({ key: "down", tone: "warn", weight: 45, title: `${plural(s.trucksDown!, "truck")} out of service`, detail: "Check expected return dates before promising loads.", href: "/fleet/trucks?status=out_of_service", cta: "See trucks" });
  if (n(s.driverReports)) out.push({ key: "reports", tone: "warn", weight: 44, title: `${plural(s.driverReports!, "driver report")} open`, detail: "Delays, breakdowns or inspection problems from drivers.", href: "/field-reports", cta: "Read reports" });
  if (n(s.billingBlocked)) out.push({ key: "blocked", tone: "info", weight: 40, title: `${plural(s.billingBlocked!, "order")} blocked from billing`, detail: "Differences between ordered and delivered to resolve or acknowledge.", href: "/billing?view=exceptions", cta: "Resolve" });
  if (n(s.tomorrowUnassigned)) out.push({ key: "tomorrow", tone: "info", weight: 35, title: `${plural(s.tomorrowUnassigned!, "load")} tomorrow without a truck`, detail: "Plan them today while trucks and drivers are free.", href: "/dispatch/plan", cta: "Plan tomorrow" });
  if (n(s.longWaitsYesterday)) out.push({ key: "waits", tone: "info", weight: 30, title: `${plural(s.longWaitsYesterday!, "long wait")} yesterday`, detail: "Trucks waited past your free time at pickups or job sites.", href: "/reports/wait-times?days=7", cta: "See where" });
  return out.sort((a, b) => b.weight - a.weight);
}

/** "Good morning" before noon, "Good afternoon" until 5 PM, then "Good evening" (the company's local hour). */
export function greetingFor(hour: number): string {
  return hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
}
