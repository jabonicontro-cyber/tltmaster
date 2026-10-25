"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { CalendarOff, ClipboardList, MessagesSquare, Route, UserRound, Wrench } from "lucide-react";
import { cn } from "@/lib/cn";
import { driverTabs, mechanicTabs } from "@/lib/companion";

const ICONS: Record<string, typeof Route> = { "/driver": Route, "/maintenance/my-jobs": Wrench, "/maintenance/work-orders": ClipboardList, "/communications": MessagesSquare, "/time-off": CalendarOff, "/profile": UserRound };

/**
 * Bottom tabs for drivers on a phone (docs/COMPANION_APP.md). Large targets, no badges or counters that invite a
 * glance while driving; every page still checks its own permission on the server.
 */
export function DriverTabBar({ permissions, kind = "driver" }: { permissions: readonly string[]; kind?: "driver" | "mechanic" }) {
  const path = usePathname() ?? "";
  const tabs = kind === "mechanic" ? mechanicTabs(permissions) : driverTabs(permissions);
  return (
    <nav aria-label={kind === "mechanic" ? "Mechanic tabs" : "Driver tabs"} className="fixed inset-x-3 bottom-[calc(env(safe-area-inset-bottom)+0.75rem)] z-30 rounded-full border border-line/70 bg-card/90 p-1.5 shadow-float backdrop-blur-md md:hidden">
      <ul className="grid gap-1" style={{ gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))` }}>
        {tabs.map((t) => {
          const Icon = ICONS[t.href] ?? Route;
          const active = t.match(path);
          return (
            <li key={t.href}>
              <Link href={t.href} aria-current={active ? "page" : undefined}
                className={cn("flex min-h-14 flex-col items-center justify-center gap-0.5 rounded-full text-xs font-semibold transition-colors duration-150", active ? "bg-strong text-white" : "text-muted active:bg-surface")}>
                <Icon className="size-5" aria-hidden />
                {t.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
