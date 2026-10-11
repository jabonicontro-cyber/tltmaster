import {
  BarChart3, Boxes, IdCard, ReceiptText, Siren, Route, MessageSquareWarning, CalendarRange, ClipboardList, FileText, Map, Settings, Ticket, Truck, Users,
  type LucideIcon,
} from "lucide-react";
import type { Permission } from "@/lib/permissions";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Shown only when the user has this permission. */
  permission?: Permission;
  /** Shown when the user has at least one of these permissions. */
  anyOf?: Permission[];
  /** Module not built yet — shown with a "Planned" label. */
  planned?: boolean;
  /** Sidebar group heading this item sits under (none: the top group). */
  group?: NavGroup;
}

export type NavGroup = "Sales" | "Operations" | "Finance" | "Company";

export const NAV_ITEMS: NavItem[] = [
  { href: "/driver", label: "My Day", icon: Route, permission: "driver.portal" },
  // One home for everyone with office, dispatch, shop or sales responsibilities (drivers start on My Day).
  { href: "/command-center", label: "Command Center", icon: Siren, anyOf: ["dispatch.view", "tickets.view", "billing.view", "fleet.view", "field_reports.view", "orders.view", "quotes.view"] },
  { href: "/customers", label: "Customers", icon: Users, permission: "customers.view", group: "Sales" },
  { href: "/quotes", label: "Quotes", icon: FileText, permission: "quotes.view", group: "Sales" },
  { href: "/materials", label: "Materials & Pricing", icon: Boxes, permission: "materials.view", group: "Sales" },
  { href: "/orders", label: "Orders", icon: ClipboardList, permission: "orders.view", group: "Operations" },
  { href: "/dispatch", label: "Dispatch", icon: CalendarRange, permission: "dispatch.view", group: "Operations" },
  { href: "/route-planner", label: "Route Planner", icon: Map, planned: true, group: "Operations" },
  { href: "/tickets", label: "Delivery Tickets", icon: Ticket, permission: "tickets.view", group: "Operations" },
  { href: "/field-reports", label: "Driver Reports", icon: MessageSquareWarning, permission: "field_reports.view", group: "Operations" },
  { href: "/fleet", label: "Fleet", icon: Truck, permission: "fleet.view", group: "Operations" },
  { href: "/billing", label: "Billing", icon: ReceiptText, permission: "billing.view", group: "Finance" },
  { href: "/reports", label: "Reports", icon: BarChart3, anyOf: ["tickets.view", "billing.view", "fleet.view", "dispatch.view"], group: "Finance" },
  { href: "/employees", label: "Employees", icon: IdCard, permission: "employees.view", group: "Company" },
  { href: "/settings", label: "Settings", icon: Settings, group: "Company" },
];
