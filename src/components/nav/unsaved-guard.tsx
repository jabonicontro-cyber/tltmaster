"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

const MESSAGE = "You have unsaved changes. Leave this page and lose them?";
const SAVED_EVENT = "taviron:saved";

/** Call after a successful save that stays on the same page (no navigation), so the guard knows the edits are kept. */
export function markSaved() {
  window.dispatchEvent(new Event(SAVED_EVENT));
}

/**
 * One guard for the whole app: a form (or an editor container) marked
 * `data-guard-unsaved` becomes "dirty" when someone edits it, and clean again
 * when it is submitted, when markSaved() is called, or on navigation. While a
 * dirty form is on the page, leaving through an in-app link asks first, and
 * closing or reloading the tab triggers the browser's own warning. Browser
 * Back/Forward keep working as usual.
 */
export function UnsavedChangesGuard() {
  const pathname = usePathname();

  useEffect(() => {
    const dirty = new Set<Element>();
    const anyDirty = () => [...dirty].some((f) => f.isConnected);
    const guardedForm = (t: EventTarget | null) => (t instanceof Element ? t.closest("[data-guard-unsaved]") : null);

    const onEdit = (e: Event) => {
      const form = guardedForm(e.target);
      if (form) dirty.add(form);
    };
    const onSubmit = (e: Event) => {
      if (e.target instanceof HTMLFormElement) dirty.delete(e.target);
    };
    const onSaved = () => dirty.clear();
    const onClick = (e: MouseEvent) => {
      if (!anyDirty() || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = e.target instanceof Element ? e.target.closest<HTMLAnchorElement>("a[href]") : null;
      if (!a || a.target === "_blank" || a.hasAttribute("download") || a.origin !== window.location.origin) return;
      if (a.pathname === window.location.pathname && a.search === window.location.search) return; // same page (e.g. an anchor)
      if (!window.confirm(MESSAGE)) {
        e.preventDefault();
        e.stopPropagation();
      } else dirty.clear();
    };
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (anyDirty()) e.preventDefault();
    };

    document.addEventListener("input", onEdit, true);
    document.addEventListener("change", onEdit, true);
    document.addEventListener("submit", onSubmit, true);
    document.addEventListener("click", onClick, true);
    window.addEventListener("beforeunload", onBeforeUnload);
    window.addEventListener(SAVED_EVENT, onSaved);
    return () => {
      window.removeEventListener(SAVED_EVENT, onSaved);
      document.removeEventListener("input", onEdit, true);
      document.removeEventListener("change", onEdit, true);
      document.removeEventListener("submit", onSubmit, true);
      document.removeEventListener("click", onClick, true);
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, [pathname]);

  return null;
}
