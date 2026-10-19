// Testing Lab (B66): the experiences the platform owner can open and check, by audience. "Implemented" describes the
// code; whether a view was actually tested is recorded by a person (platform_testing_record), never inferred from a
// page loading.
import type { PreviewRole } from "./preview";

export type LabAudience = "platform" | "company" | "employee" | "customer" | "prospect" | "onboarding";
export type LabImplementation = "available" | "needs_config" | "blocked" | "not_implemented";
export type LabCheck = "tested" | "failing" | "needs_config" | "blocked";

export type LabView = {
  key: string;
  audience: LabAudience;
  title: string;
  what: string;
  /** How it opens: a demo role view, a customer portal preview, or a plain link. */
  open: { kind: "role"; role: PreviewRole | null; to?: "help" } | { kind: "portal" } | { kind: "link"; href: string; external?: boolean } | { kind: "none" };
  implementation: LabImplementation;
  /** Why it is not simply available (configuration, migration, not built). */
  note?: string;
  /** Needs a database update that may not be installed yet. */
  migration?: string;
};

export const AUDIENCE_LABELS: Record<LabAudience, string> = {
  platform: "Taviron platform administrator",
  company: "Trucking company owner or administrator",
  employee: "Company employees",
  customer: "The trucking company's customers",
  prospect: "Prospects (public website and live demo)",
  onboarding: "New customer onboarding",
};

export const CHECK_LABELS: Record<LabCheck, string> = {
  tested: "Tested",
  failing: "Failing",
  needs_config: "Needs configuration",
  blocked: "Blocked",
};

export const IMPLEMENTATION_LABELS: Record<LabImplementation, string> = {
  available: "Available to preview",
  needs_config: "Requires configuration",
  blocked: "Blocked by a dependency",
  not_implemented: "Not implemented",
};

export const LAB_VIEWS: LabView[] = [
  { key: "platform.console", audience: "platform", title: "Platform console", what: "Launchpad, companies, leads, plans, demos, support.", open: { kind: "link", href: "/admin" }, implementation: "available" },
  { key: "platform.help-support", audience: "platform", title: "Help support inbox", what: "Support requests and help feedback from companies.", open: { kind: "link", href: "/admin/support" }, implementation: "available", migration: "20261120000400" },
  { key: "company.owner", audience: "company", title: "Owner workspace", what: "Command Center, settings, people, billing — the owner's full view.", open: { kind: "role", role: "owner" }, implementation: "available" },
  { key: "company.help", audience: "company", title: "Business Help Center", what: "Articles, guides and support requests for company users.", open: { kind: "role", role: "owner", to: "help" }, implementation: "available", migration: "20261120000400" },
  { key: "company.portal-admin", audience: "company", title: "Customer portal administration", what: "Requests inbox, customer access, help articles, portal settings.", open: { kind: "link", href: "/customer-portal" }, implementation: "available", migration: "20261120000700" },
  { key: "employee.dispatcher", audience: "employee", title: "Dispatcher", what: "Dispatch board, Plan the day, orders.", open: { kind: "role", role: "dispatcher" }, implementation: "available" },
  { key: "employee.multi", audience: "employee", title: "Dispatcher who also drives", what: "Dispatch plus the driver's own day.", open: { kind: "role", role: "multi" }, implementation: "available" },
  { key: "employee.office", audience: "employee", title: "Office", what: "Customers, quotes, tickets, billing.", open: { kind: "role", role: "office" }, implementation: "available" },
  { key: "employee.driver", audience: "employee", title: "Driver", what: "My Day, tickets with photos, reports (companion app).", open: { kind: "role", role: "driver" }, implementation: "available" },
  { key: "employee.mechanic", audience: "employee", title: "Mechanic", what: "Maintenance, work orders, fleet.", open: { kind: "role", role: "mechanic" }, implementation: "available" },
  { key: "customer.portal", audience: "customer", title: "Customer portal", what: "Orders, deliveries, tickets, quotes, support and help — as one demo customer.", open: { kind: "portal" }, implementation: "available", migration: "20261120000700" },
  { key: "customer.tracking", audience: "customer", title: "Shared tracking link", what: "Create one from a demo order page (Customer Tracking), then open it signed out.", open: { kind: "none" }, implementation: "available", migration: "20261120000700" },
  { key: "customer.invoices", audience: "customer", title: "Invoices and payments in the portal", what: "Customers see invoices and pay online.", open: { kind: "none" }, implementation: "blocked", note: "No issued invoices exist in Taviron (drafts only) and no payment provider is approved or connected." },
  { key: "prospect.website", audience: "prospect", title: "Public website", what: "Home, platform, pricing (gated), demo request.", open: { kind: "link", href: "/", external: true }, implementation: "available" },
  { key: "prospect.demo", audience: "prospect", title: "Live demo request", what: "The demo request form and its (simulated) follow-up.", open: { kind: "link", href: "/demo", external: true }, implementation: "available" },
  { key: "onboarding.company", audience: "onboarding", title: "Company sign-up with access code", what: "A new company creates its account and starts setup.", open: { kind: "link", href: "/signup", external: true }, implementation: "available" },
  { key: "onboarding.portal", audience: "onboarding", title: "Guided customer onboarding portal", what: "Checklist, uploads, review and readiness for a new customer.", open: { kind: "none" }, implementation: "not_implemented", note: "Planned (master plan B68). Today: onboarding imports in the platform console and the Setup checklist in each workspace." },
];

/** The latest recorded check for a view in a company (or across demos when none is chosen). */
export function latestCheck<T extends { view_key: string; company_id: string | null; checked_at: string }>(checks: T[], view: string, company: string | null): T | null {
  return checks.filter((c) => c.view_key === view && (company === null || c.company_id === company)).sort((a, b) => b.checked_at.localeCompare(a.checked_at))[0] ?? null;
}
