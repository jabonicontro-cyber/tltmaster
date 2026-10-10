import {
  BarChart3, Boxes, CalendarRange, ClipboardList, FileText, LayoutDashboard, Map, Settings, Ticket, Truck, Users,
  type LucideIcon,
} from "lucide-react";
import type { Permission } from "@/lib/permissions";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Shown only when the user has this permission. */
  permission?: Permission;
  /** Module not built yet — shown with a "Planned" label. */
  planned?: boolean;
}

export const NAV_ITEMS: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/customers", label: "Customers", icon: Users, permission: "customers.view" },
  { href: "/quotes", label: "Quotes", icon: FileText, permission: "quotes.view" },
  { href: "/orders", label: "Orders", icon: ClipboardList, planned: true },
  { href: "/dispatch", label: "Dispatch", icon: CalendarRange, planned: true },
  { href: "/route-planner", label: "Route Planner", icon: Map, planned: true },
  { href: "/tickets", label: "Delivery Tickets", icon: Ticket, planned: true },
  { href: "/fleet", label: "Fleet", icon: Truck, planned: true },
  { href: "/materials", label: "Materials & Pricing", icon: Boxes, permission: "materials.view" },
  { href: "/reports", label: "Reports", icon: BarChart3, planned: true },
  { href: "/settings", label: "Settings", icon: Settings },
];
