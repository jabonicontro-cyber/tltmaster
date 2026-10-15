"use client";

import { useEffect } from "react";

/** Registers the companion app's service worker (public/sw.js: offline page only, no company data). */
export function ServiceWorkerRegistration() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {
      // Not fatal: the app works the same without it, only without the offline page.
    });
  }, []);
  return null;
}
