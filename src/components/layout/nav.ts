import {
  BarChart3, Boxes, ReceiptText, Siren, Route, MessageSquareWarning, CalendarRange, ClipboardList, FileText, Map, Settings, Ticket, Truck, Users,
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
}

export const NAV_ITEMS: NavItem[] = [
  { href: "/driver", label: "My Day", icon: Route, permission: "driver.portal" },
  // One home for everyone with office, dispatch, shop or sales responsibilities (drivers start on My Day).
  { href: "/command-center", label: "Command Center", icon: Siren, anyOf: ["dispatch.view", "tickets.view", "billing.view", "fleet.view", "field_reports.view", "orders.view", "quotes.view"] },
  { href: "/customers", label: "Customers", icon: Users, permission: "customers.view" },
  { href: "/quotes", label: "Quotes", icon: FileText, permission: "quotes.view" },
  { href: "/orders", label: "Orders", icon: ClipboardList, permission: "orders.view" },
  { href: "/dispatch", label: "Dispatch", icon: CalendarRange, permission: "dispatch.view" },
  { href: "/route-planner", label: "Route Planner", icon: Map, planned: true },
  { href: "/tickets", label: "Delivery Tickets", icon: Ticket, permission: "tickets.view" },
  { href: "/field-reports", label: "Driver Reports", icon: MessageSquareWarning, permission: "field_reports.view" },
  { href: "/billing", label: "Billing", icon: ReceiptText, permission: "billing.view" },
  { href: "/fleet", label: "Fleet", icon: Truck, permission: "fleet.view" },
  { href: "/materials", label: "Materials & Pricing", icon: Boxes, permission: "materials.view" },
  { href: "/reports", label: "Reports", icon: BarChart3, planned: true },
  { href: "/settings", label: "Settings", icon: Settings },
];
