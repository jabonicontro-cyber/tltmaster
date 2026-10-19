"use client";

import { TERMS } from "@/lib/terminology";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";
import { APP_CONTAINER } from "@/lib/layout";

const NAV = [
  { href: "/admin", label: "Launchpad" },
  { href: "/admin/leads", label: "Leads" },
  { href: "/admin/companies", label: "Companies" },
  { href: "/admin/plans", label: "Plans" },
  { href: "/admin/onboarding", label: "Onboarding" },
  { href: "/admin/demo", label: TERMS.demoManagement },
  { href: "/admin/support", label: "Support" },
  { href: "/admin/platform", label: "Administration" },
];

/** The platform area's tabs, with the current one marked (also for screen readers). */
export function AdminNav() {
  const path = usePathname();
  return (
    <nav aria-label="Platform" className={cn(APP_CONTAINER, "flex gap-1 overflow-x-auto")}>
      {NAV.map((n) => {
        const current = n.href === "/admin" ? path === "/admin" : path === n.href || path.startsWith(`${n.href}/`);
        return (
          <Link
            key={n.href}
            href={n.href}
            aria-current={current ? "page" : undefined}
            className={cn(
              "rounded-t-md px-3 py-2 text-sm font-semibold whitespace-nowrap transition-colors",
              current ? "bg-surface text-ink" : "text-white/75 hover:bg-white/10 hover:text-white",
            )}
          >
            {n.label}
          </Link>
        );
      })}
    </nav>
  );
}
