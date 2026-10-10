"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * Review-queue shortcuts: J next, K previous, A opens the Accept confirmation
 * (it never accepts by itself). Ignored while typing or when a dialog is open.
 */
export function QueueKeys({ nextHref, prevHref }: { nextHref: string | null; prevHref: string | null }) {
  const router = useRouter();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(el.tagName))) return;
      if (document.querySelector("[role=dialog]")) return;
      const k = e.key.toLowerCase();
      if (k === "j" && nextHref) router.push(nextHref);
      else if (k === "k" && prevHref) router.push(prevHref);
      else if (k === "a") document.querySelector<HTMLButtonElement>("[data-accept-ticket]")?.click();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [nextHref, prevHref, router]);
  return null;
}
