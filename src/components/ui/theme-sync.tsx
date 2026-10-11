"use client";

import { useSyncExternalStore } from "react";
import { THEME_EVENT, readTheme, resolveTheme } from "@/lib/theme";

function subscribe(onChange: () => void) {
  const mq = matchMedia("(prefers-color-scheme: dark)");
  // "Match my device": follow the device when it switches while the page is open.
  const onSystem = () => {
    if (readTheme() === "system") document.documentElement.dataset.theme = resolveTheme("system", mq.matches);
    onChange();
  };
  mq.addEventListener("change", onSystem);
  window.addEventListener(THEME_EVENT, onChange);
  window.addEventListener("storage", onSystem); // another tab changed the choice
  return () => {
    mq.removeEventListener("change", onSystem);
    window.removeEventListener(THEME_EVENT, onChange);
    window.removeEventListener("storage", onSystem);
  };
}

/** The saved preference ("system" during server rendering). */
export function useThemePreference() {
  return useSyncExternalStore(subscribe, readTheme, () => "system" as const);
}

/** The theme in effect right now. */
export function useResolvedTheme(): "light" | "dark" {
  return useSyncExternalStore(
    subscribe,
    () => (document.documentElement.dataset.theme === "dark" ? "dark" : "light"),
    () => "light" as const,
  );
}
