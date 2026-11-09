"use client";

import Link from "next/link";
import { Suspense } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { CalendarOff, ClipboardList, LayoutGrid, MessagesSquare, Route, UserRound, Wrench } from "lucide-react";
import { cn } from "@/lib/cn";
import { dispatcherDriverTabs, driverTabs, mechanicTabs } from "@/lib/companion";

const ICONS: Record<string, typeof Route> = { "/driver": Route, "/maintenance/my-jobs": Wrench, "/maintenance/work-orders": ClipboardList, "/communications": MessagesSquare, "/time-off": CalendarOff, "/profile": UserRound, "/dispatch": LayoutGrid };

/**
 * Bottom tabs for drivers on a phone (docs/COMPANION_APP.md). Large targets, no badges or counters that invite a
 * glance while driving; every page still checks its own permission on the server.
 */
type Props = { permissions: readonly string[]; kind?: "driver" | "mechanic" | "dispatcher-driver" };

export function DriverTabBar(props: Props) {
  // The search parameters only refine which tab is lit; until they are read, the bar shows from the path alone.
  return (
    <Suspense fallback={<Bar {...props} from={null} />}>
      <BarWithSearch {...props} />
    </Suspense>
  );
}

function BarWithSearch(props: Props) {
  const search = useSearchParams();
  return <Bar {...props} from={search?.get("from") ?? null} />;
}

function Bar({ permissions, kind = "driver", from }: Props & { from: string | null }) {
  // Only ?from=my-jobs is passed on (a job opened from My jobs keeps that tab lit); other parameters never change the tab.
  const path = `${usePathname() ?? ""}${from === "my-jobs" ? "?from=my-jobs" : ""}`;
  const tabs = kind === "mechanic" ? mechanicTabs(permissions) : kind === "dispatcher-driver" ? dispatcherDriverTabs(permissions) : driverTabs(permissions);
  return (
    <nav aria-label={kind === "mechanic" ? "Mechanic tabs" : kind === "dispatcher-driver" ? "Dispatch and driving tabs" : "Driver tabs"} className="fixed inset-x-3 bottom-[calc(env(safe-area-inset-bottom)+0.75rem)] z-30 rounded-full border border-line/70 bg-card/90 p-1.5 shadow-float backdrop-blur-md md:hidden">
      <ul className="grid gap-1" style={{ gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))` }}>
        {tabs.map((t) => {
          const Icon = ICONS[t.href] ?? Route;
          const active = t.match(path);
          return (
            <li key={t.href}>
              <Link href={t.href} aria-current={active ? "page" : undefined}
                className={cn("flex min-h-14 flex-col items-center justify-center gap-0.5 rounded-full px-1 text-[11px] leading-tight font-semibold transition-colors duration-150", active ? "bg-strong text-white" : "text-muted active:bg-surface")}>
                <Icon className="size-5" aria-hidden />
                {/* One line per label (labels are kept short: five tabs share a 360px phone). */}
                <span className="max-w-full truncate whitespace-nowrap">{t.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
