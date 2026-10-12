"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { POLL_SECONDS } from "@/lib/communications";

/**
 * Keeps an open Communications page current by re-rendering it from the server
 * every POLL_SECONDS while the tab is visible (no realtime service is used;
 * see docs/COMMUNICATIONS.md). Also refreshes when the tab becomes visible.
 */
export function Poller({ seconds = POLL_SECONDS }: { seconds?: number }) {
  const router = useRouter();
  useEffect(() => {
    const tick = () => { if (document.visibilityState === "visible") router.refresh(); };
    const t = window.setInterval(tick, seconds * 1000);
    document.addEventListener("visibilitychange", tick);
    return () => { window.clearInterval(t); document.removeEventListener("visibilitychange", tick); };
  }, [router, seconds]);
  return null;
}
