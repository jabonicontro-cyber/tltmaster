"use client";

import { Fragment } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";
import { NAV_ITEMS } from "./nav";
import type { Permission } from "@/lib/permissions";

/**
 * `collapsed`: the desktop icon rail. Labels stay in the page (screen readers
 * and the hover/focus expansion use them) but are faded out; group headings
 * become thin dividers. The phone menu never collapses.
 */
export function SidebarNav({ permissions, onNavigate, collapsed = false }: { permissions: Permission[]; onNavigate?: () => void; collapsed?: boolean }) {
  const pathname = usePathname();
  const items = NAV_ITEMS.filter((i) => (!i.permission || permissions.includes(i.permission)) && (!i.anyOf || i.anyOf.some((p) => permissions.includes(p))));
  return (
    <nav aria-label="Main" className="flex flex-col gap-0.5 px-3">
      {items.map((item, i) => {
        // A quiet heading where a new group starts, so a long menu scans in sections.
        const heading = item.group && item.group !== items[i - 1]?.group ? item.group : null;
        const active = pathname === item.href || pathname.startsWith(item.href + "/");
        const Icon = item.icon;
        return (
          <Fragment key={item.href}>
          {heading && (
            <p className={cn("relative mt-4 mb-1 h-4 px-3 text-[11px] font-semibold tracking-[0.08em] whitespace-nowrap text-white/40 uppercase")}>
              <span className={cn("transition-opacity duration-150 motion-reduce:transition-none", collapsed ? "opacity-0" : "opacity-100")}>{heading}</span>
              <span className={cn("absolute inset-x-3 top-1/2 h-px bg-white/10 transition-opacity duration-150 motion-reduce:transition-none", collapsed ? "opacity-100" : "opacity-0")} aria-hidden />
            </p>
          )}
          <Link
            href={item.href}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            className={cn(
              "group relative flex min-h-10 items-center gap-3 rounded-md px-3 py-2 text-sm font-medium whitespace-nowrap transition-colors",
              active ? "bg-white/10 text-white" : "text-white/70 hover:bg-white/[0.06] hover:text-white",
            )}
          >
            <span className={cn("absolute top-1.5 bottom-1.5 -left-2 w-1 rounded-r bg-brand", active ? "opacity-100" : "opacity-0")} aria-hidden />
            <Icon className={cn("size-[18px] shrink-0", active ? "text-white" : "text-white/55 group-hover:text-white/85")} aria-hidden />
            <span className={cn("flex-1 truncate transition-opacity duration-150 motion-reduce:transition-none", collapsed && "opacity-0")}>{item.label}</span>
            {item.planned && !collapsed && (
              <span className="rounded border border-white/15 px-1.5 py-px text-[10px] font-medium tracking-wide text-white/55 uppercase">
                Planned
              </span>
            )}
          </Link>
          </Fragment>
        );
      })}
    </nav>
  );
}
