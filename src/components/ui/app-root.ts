"use client";

import { useSyncExternalStore } from "react";

const subscribe = () => () => {};
const getRoot = () => (document.querySelector(".app-root") as HTMLElement | null) ?? undefined;
const getServerRoot = () => undefined;

/**
 * The page's .app-root, where the company's colours and the dark-mode palette are set: pop-ups (dialogs, tips) render
 * inside it so they keep them (2026-11-09: dialogs portalled to <body> showed the default blue buttons). Undefined on
 * the server and on pages without one, so the portal falls back to <body>.
 */
export function useAppRoot(): HTMLElement | undefined {
  return useSyncExternalStore(subscribe, getRoot, getServerRoot);
}
