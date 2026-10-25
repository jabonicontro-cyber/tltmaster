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
  { href: "/admin/testing-lab", label: "Testing Lab" },
  { href: "/admin/support", label: "Support" },
  { href: "/admin/platform", label: "Administration" },
];

/** The platform area's tabs, with the current one marked (also for screen readers). */
export function AdminNav() {
  const path = usePathname();
  return (
    <nav
      aria-label="Platform"
      // Narrow screens: the tabs scroll sideways; the fading right edge shows there are more (no wrap, no clipping mid-word).
      className={cn(APP_CONTAINER, "pb-3")}
    >
      <div className="flex w-fit max-w-full snap-x gap-1 overflow-x-auto rounded-full bg-white/[0.07] p-1 [mask-image:linear-gradient(to_right,black_calc(100%-2rem),transparent)] lg:[mask-image:none]">
      {NAV.map((n) => {
        const current = n.href === "/admin" ? path === "/admin" : path === n.href || path.startsWith(`${n.href}/`);
        return (
          <Link
            key={n.href}
            href={n.href}
            aria-current={current ? "page" : undefined}
            className={cn(
              "snap-start rounded-full px-3.5 pt-1.5 pb-[7px] text-sm leading-5 font-semibold whitespace-nowrap transition-colors duration-150",
              current ? "bg-white text-charcoal shadow-xs" : "text-white/70 hover:bg-white/[0.08] hover:text-white",
            )}
          >
            {n.label}
          </Link>
        );
      })}
      </div>
    </nav>
  );
}
