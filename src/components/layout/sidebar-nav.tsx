"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";
import { NAV_ITEMS } from "./nav";
import type { Permission } from "@/lib/permissions";

export function SidebarNav({ permissions, onNavigate }: { permissions: Permission[]; onNavigate?: () => void }) {
  const pathname = usePathname();
  const items = NAV_ITEMS.filter((i) => !i.permission || permissions.includes(i.permission));
  return (
    <nav aria-label="Main" className="flex flex-col gap-0.5 px-2">
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
              "group relative flex items-center gap-3 rounded-md px-3 py-2.5 text-[15px] font-medium transition-colors",
              active ? "bg-white/10 text-white" : "text-white/75 hover:bg-white/5 hover:text-white",
            )}
          >
            <span className={cn("absolute left-0 h-6 w-1 rounded-r bg-brand", active ? "opacity-100" : "opacity-0")} aria-hidden />
            <Icon className={cn("size-5 shrink-0", active ? "text-brand" : "text-white/60 group-hover:text-white/90")} aria-hidden />
            <span className="flex-1 truncate">{item.label}</span>
            {item.planned && (
              <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-white/60 uppercase">
                Planned
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
