"use client";

import type { ReactNode } from "react";
import { useEffect, useRef, useTransition } from "react";
import { useRouter } from "next/navigation";

/**
 * A filter form that applies itself (owner 2026-10-28: results update as you type). Typing in the search waits a moment
 * (250 ms) and then updates the list; choosing a filter updates it at once. It stays a plain GET form, so Apply, the
 * URL and bookmarks keep working, and without JavaScript nothing changes. The page number resets with every change.
 */
export function LiveFilterForm({ action, className, children }: { action: string; className?: string; children: ReactNode }) {
  const router = useRouter();
  const form = useRef<HTMLFormElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [pending, startTransition] = useTransition();
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const apply = () => {
    const el = form.current;
    if (!el) return;
    const params = new URLSearchParams();
    for (const [k, v] of new FormData(el)) if (typeof v === "string" && v.trim() !== "" && k !== "page") params.set(k, v.trim());
    startTransition(() => router.replace(`${action}${params.size ? `?${params}` : ""}`, { scroll: false }));
  };

  return (
    <form
      ref={form}
      action={action}
      method="get"
      role="search"
      aria-busy={pending}
      className={className}
      onInput={(e) => {
        const t = e.target as HTMLElement;
        if (!(t instanceof HTMLInputElement) || t.type !== "search") return;
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(apply, 250);
      }}
      onChange={(e) => {
        if (e.target instanceof HTMLSelectElement) apply();
      }}
      onSubmit={(e) => {
        e.preventDefault();
        if (timer.current) clearTimeout(timer.current);
        apply();
      }}
    >
      {children}
    </form>
  );
}
