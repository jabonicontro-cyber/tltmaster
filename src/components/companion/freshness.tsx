"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { WifiOff } from "lucide-react";
import { cn } from "@/lib/cn";
import { freshness, STALE_AFTER_MS, type Freshness } from "@/lib/companion";

/**
 * When this screen's data was read, and whether it may be out of date (docs/COMPANION_APP.md §4). The page is fetched
 * again when the phone comes back online or the app returns to the foreground after more than a minute; while offline
 * or stale it says so instead of presenting old loads as current.
 */
export function Freshness({ renderedAt, timeZone }: { renderedAt: number; timeZone: string }) {
  const router = useRouter();
  const [state, setState] = useState<Freshness>("current");
  useEffect(() => {
    const check = () => setState(freshness(renderedAt, Date.now(), navigator.onLine));
    const refreshIfOld = () => {
      check();
      if (navigator.onLine && document.visibilityState === "visible" && Date.now() - renderedAt > 60_000) router.refresh();
    };
    check();
    const timer = window.setInterval(check, Math.min(STALE_AFTER_MS, 30_000));
    window.addEventListener("online", refreshIfOld);
    window.addEventListener("offline", check);
    document.addEventListener("visibilitychange", refreshIfOld);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("online", refreshIfOld);
      window.removeEventListener("offline", check);
      document.removeEventListener("visibilitychange", refreshIfOld);
    };
  }, [renderedAt, router]);
  const time = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone }).format(renderedAt);
  if (state === "current") return <p className="text-xs text-muted" data-freshness="current">Updated {time}</p>;
  return (
    <div role="status" data-freshness={state} className={cn("flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border px-3 py-2 text-sm", "border-line bg-surface text-ink")}>
      {state === "offline" && <WifiOff className="size-4 text-muted" aria-hidden />}
      <span>
        {state === "offline" ? "No connection." : "This may be out of date."} Shown as of {time}; check with dispatch before relying on it.
      </span>
      {state === "stale" && <button type="button" onClick={() => router.refresh()} className="font-semibold underline">Refresh</button>}
    </div>
  );
}
