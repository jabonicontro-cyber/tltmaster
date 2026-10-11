"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";
import { NAV_ITEMS } from "./nav";
import type { Permission } from "@/lib/permissions";

export function SidebarNav({ permissions, onNavigate }: { permissions: Permission[]; onNavigate?: () => void }) {
  const pathname = usePathname();
  const items = NAV_ITEMS.filter((i) => (!i.permission || permissions.includes(i.permission)) && (!i.anyOf || i.anyOf.some((p) => permissions.includes(p))));
  return (
    <nav aria-label="Main" className="flex flex-col gap-0.5 px-3">
      {items.map((item) => {
        const active = pathname === item.href || pathname.startsWith(item.href + "/");
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            className={cn(
              "group relative flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
              active ? "bg-white/10 text-white" : "text-white/70 hover:bg-white/[0.06] hover:text-white",
            )}
          >
            <span className={cn("absolute top-1.5 bottom-1.5 -left-2 w-1 rounded-r bg-brand", active ? "opacity-100" : "opacity-0")} aria-hidden />
            <Icon className={cn("size-[18px] shrink-0", active ? "text-white" : "text-white/55 group-hover:text-white/85")} aria-hidden />
            <span className="flex-1 truncate">{item.label}</span>
            {item.planned && (
              <span className="rounded border border-white/15 px-1.5 py-px text-[10px] font-medium tracking-wide text-white/55 uppercase">
                Planned
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
