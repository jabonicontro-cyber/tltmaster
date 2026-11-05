// Simple mode (owner 2026-11-05, master plan SF1): a company hides the areas it doesn't use from the menu, so a small
// fleet sees only what it needs. Hiding changes the menu only: permissions, rules and pages stay the same (a hidden page
// still opens from a link), and safety areas (Safety, Driver Reports, Communications) can never be hidden.

export const OPTIONAL_AREAS = [
  { href: "/quotes", label: "Quotes", hint: "Quotes for customers before an order." },
  { href: "/support", label: "Support", hint: "Requests from your customers' portal." },
  { href: "/customer-portal", label: "Customer Portal", hint: "Your customers' own sign-in." },
  { href: "/maintenance", label: "Maintenance", hint: "Your own shop: work orders, mechanics, parts." },
  { href: "/order-to-cash", label: "Order to Cash", hint: "Every order from delivery to payment." },
  { href: "/payroll", label: "Payroll", hint: "Driver pay from delivery tickets." },
  { href: "/schedule", label: "Schedule", hint: "Shift schedules for your people." },
  { href: "/time-off", label: "Time Off", hint: "Requests, approvals and balances." },
  { href: "/reports", label: "Reports", hint: "Operations and revenue reports." },
] as const;

export type OptionalArea = (typeof OPTIONAL_AREAS)[number]["href"];
const HREFS = new Set<string>(OPTIONAL_AREAS.map((a) => a.href));

/** Any stored list, made safe: only known optional areas, each once. */
export function hiddenAreasOf(value: unknown): OptionalArea[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((v): v is OptionalArea => typeof v === "string" && HREFS.has(v)))];
}

/** Whether a menu item stays visible: everything except the optional areas the company hid. */
export function menuShows(href: string, hidden: readonly string[]): boolean {
  return !(HREFS.has(href) && hidden.includes(href));
}
