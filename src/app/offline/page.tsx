import { OfflineDay } from "@/components/companion/offline-day";
import { TavironEmblem } from "@/components/layout/brand";

export const metadata = { title: "No connection" };
export const dynamic = "force-static";

/**
 * Shown by the companion app's service worker when a page cannot be loaded (public/sw.js). The page itself holds no
 * company data. On a driver's phone it shows the day saved there (B133, owner 2026-11-02), plainly marked with the time
 * it was read, and lets the driver save tickets, inspections and Arrived/Left taps to send later.
 */
export default function OfflinePage() {
  return (
    <main id="main" className="flex min-h-dvh flex-col items-center justify-center gap-5 bg-surface px-6 text-center">
      <TavironEmblem className="size-12" />
      <h1 className="text-2xl font-bold text-ink">No connection</h1>
      <OfflineDay />
      <a href="/dashboard" className="inline-flex min-h-12 items-center rounded-xl bg-action px-6 text-base font-semibold text-white">Try again</a>
    </main>
  );
}
