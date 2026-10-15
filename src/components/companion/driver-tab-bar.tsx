"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { CalendarOff, MessagesSquare, Route, UserRound } from "lucide-react";
import { cn } from "@/lib/cn";
import { driverTabs } from "@/lib/companion";

const ICONS: Record<string, typeof Route> = { "/driver": Route, "/communications": MessagesSquare, "/time-off": CalendarOff, "/profile": UserRound };

/**
 * Bottom tabs for drivers on a phone (docs/COMPANION_APP.md). Large targets, no badges or counters that invite a
 * glance while driving; every page still checks its own permission on the server.
 */
export function DriverTabBar({ permissions }: { permissions: readonly string[] }) {
  const path = usePathname() ?? "";
  const tabs = driverTabs(permissions);
  return (
    <nav aria-label="Driver tabs" className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-card pb-[env(safe-area-inset-bottom)] md:hidden">
      <ul className="grid" style={{ gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))` }}>
        {tabs.map((t) => {
          const Icon = ICONS[t.href] ?? Route;
          const active = t.match(path);
          return (
            <li key={t.href}>
              <Link href={t.href} aria-current={active ? "page" : undefined}
                className={cn("flex min-h-14 flex-col items-center justify-center gap-0.5 text-xs font-semibold", active ? "text-brand-fg" : "text-muted")}>
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
