// Permission codes. The role → permission mapping lives in the database
// (public.role_permissions) and is editable by the owner; this list only
// gives the codes a type.
export const PERMISSIONS = [
  "customers.view",
  "customers.edit",
  "materials.view",
  "materials.edit",
  "pricing.edit",
  "pricing.override",
  "quotes.view",
  "quotes.edit",
  "quotes.send",
  "quotes.status",
  "orders.view",
  "orders.edit",
  "orders.schedule",
  "fleet.view",
  "fleet.edit",
  "fleet.service",
  "fleet.assign",
  "dispatch.view",
  "dispatch.edit",
  "tickets.view",
  "tickets.edit",
  "tickets.review",
  "billing.view",
  "billing.manage",
  "exceptions.assign",
  "driver.portal",
  "field_reports.view",
  "field_reports.manage",
  "settings.manage",
  "users.manage",
  "employees.view",
  "employees.edit",
  "employees.compensation",
  "time_off.view",
  "time_off.approve",
  "time_off.balances",
  "schedules.manage",
  "maintenance.view",
  "maintenance.manage",
  "maintenance.costs",
  "maintenance.clear",
  "comms.message",
  "comms.groups",
  "comms.channels",
  "comms.announce",
  "comms.operations",
  "comms.alerts",
  "comms.admin",
  "audit.view",
  "payroll.manage",
  "safety.view",
  "safety.manage",
  "accounting.view",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/** Roles given to people who work in the company (role pickers). */
export const ROLES = ["owner", "office", "dispatcher", "mechanic", "driver"] as const;
/** Every role, including an outside accountant's time-limited, read-only role (B134; given only through Accountant access). */
export type AppRole = (typeof ROLES)[number] | "accountant";

export const ROLE_LABELS: Record<AppRole, string> = {
  owner: "Owner / Administrator",
  office: "Office staff",
  dispatcher: "Dispatcher",
  mechanic: "Mechanic",
  driver: "Driver",
  accountant: "Outside accountant",
};

export interface Access {
  userId: string;
  /** The company this session works in; every query is limited to it by the database. */
  companyId: string | null;
  companyName: string | null;
  email: string;
  fullName: string;
  role: AppRole | null;
  active: boolean;
  permissions: Permission[];
  /** The current company is a demo company (fictional data, no external side effects). */
  isDemo?: boolean;
  /** A role preview shown in the demo company (presentation only; see src/lib/platform/preview.ts). */
  preview?: string | null;
  /** This session is a Taviron support visit (owner permissions until endsAt; 20261120008900). */
  support?: { endsAt: string } | null;
  /** An owner of this company, while Taviron support is inside (the banner). */
  supportInside?: boolean;
  /** Changes Taviron support asked for that wait for an owner (owners and visiting staff; 20261120009200). */
  supportRequests?: number;
}

export function can(access: Pick<Access, "permissions"> | null | undefined, permission: Permission): boolean {
  return Boolean(access?.permissions.includes(permission));
}

/**
 * An outside accountant's sign-in (B134): its role can hold only these two permissions (enforced by the database), so
 * the app shows it only the accountant view and the finance pages it may read.
 */
export function isAccountantOnly(permissions: readonly string[]): boolean {
  return permissions.includes("accounting.view") && permissions.every((p) => p === "accounting.view" || p === "billing.view");
}
