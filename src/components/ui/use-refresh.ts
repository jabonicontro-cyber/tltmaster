"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useTransition } from "react";

/**
 * Reload the page's data after a change and know when the screen shows it (walkthrough 2026-11-14, M3/D4/P9).
 *
 * `router.refresh()` returns at once while the server renders the page again, which takes one to several seconds on
 * the heavier pages (billing, orders, maintenance). Calling it bare after a toast left the old figures and buttons on
 * screen and clickable in the meantime, so a person saw "Saved" next to the state from before. Wrapped in a
 * transition, `refreshing` stays true until the new page is on screen, and `refresh()` resolves then: keep the
 * button busy (or the dialog open) until it does.
 *
 * Never `await refresh()` inside `startTransition(async () => …)` (a useTransition or a form action): React holds a
 * transition started during an async transition until that one ends, so both would wait for each other until the
 * 20-second fallback. There, call `void refresh().then(…)` and show `saving || refreshing` as busy. Awaiting it is
 * right in a plain async handler, such as a ConfirmDialog's onConfirm.
 */
export function useRefresh() {
  const router = useRouter();
  const [refreshing, start] = useTransition();
  const waiting = useRef<Array<() => void>>([]);
  const started = useRef(false);

  useEffect(() => {
    if (refreshing) started.current = true;
    else if (started.current) {
      started.current = false;
      const done = waiting.current;
      waiting.current = [];
      for (const resolve of done) resolve();
    }
  }, [refreshing]);

  const refresh = useCallback(
    () =>
      new Promise<void>((resolve) => {
        // Never leave a button busy for good: the page is usable again after 20 s even if the reload never finished.
        const timer = setTimeout(resolve, 20_000);
        waiting.current.push(() => {
          clearTimeout(timer);
          resolve();
        });
        start(() => router.refresh());
      }),
    [router],
  );

  return { refresh, refreshing };
}
