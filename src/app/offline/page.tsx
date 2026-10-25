import { TavironEmblem } from "@/components/layout/brand";

export const metadata = { title: "No connection" };
export const dynamic = "force-static";

/**
 * Shown by the companion app's service worker when a page cannot be loaded (public/sw.js). It holds no company data
 * and never pretends to: loads, times and instructions are only shown after a fresh answer from Taviron.
 */
export default function OfflinePage() {
  return (
    <main id="main" className="flex min-h-dvh flex-col items-center justify-center gap-5 bg-surface px-6 text-center">
      <TavironEmblem className="size-12" />
      <h1 className="text-2xl font-bold text-ink">No connection</h1>
      <p className="max-w-sm text-[15px] text-muted">
        Taviron could not be reached, so nothing is shown here. Your loads and messages appear again once you are back
        online. If you need something now, call dispatch.
      </p>
      <a href="/dashboard" className="inline-flex min-h-12 items-center rounded-xl bg-action px-6 text-base font-semibold text-white">Try again</a>
    </main>
  );
}
