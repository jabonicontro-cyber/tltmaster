"use client";

import { useMemo, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { CheckCircle2, ChevronRight, Circle, X } from "lucide-react";
import { dismissGettingStarted } from "@/app/(app)/getting-started-actions";
import { itemDone, showChecklist, type GettingStartedItem } from "@/lib/getting-started";
import { cn } from "@/lib/cn";

type Stored = { dismissed?: boolean; opened?: string[] };

// This browser's memory for the person (opened steps; the dismissal when the account cannot keep it), read as an
// external store so the server render and the first paint agree and later writes re-render the card.
const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
};
function rawStored(key: string): string {
  try {
    return window.localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}
function parseStored(raw: string): Stored {
  try {
    const v = raw ? (JSON.parse(raw) as Stored) : {};
    return { dismissed: v.dismissed === true, opened: Array.isArray(v.opened) ? v.opened.filter((x): x is string => typeof x === "string").slice(0, 20) : [] };
  } catch {
    return {};
  }
}
function writeStored(key: string, v: Stored) {
  try {
    window.localStorage.setItem(key, JSON.stringify(v));
  } catch {
    // Private windows and blocked storage: the account (or nothing) remembers it instead.
  }
  listeners.forEach((fn) => fn());
}

/**
 * The "Getting started" card: the person's first steps in their role, each a way in, ticked from recorded data or
 * (for a step nothing records) once opened on this device. The next step carries the one obvious action. "Hide" puts
 * it away for this person in this company; it is also gone once every step is done.
 */
export function GettingStartedCard({ items, storageKey, roleLabel }: { items: GettingStartedItem[]; storageKey: string; roleLabel: string }) {
  // null on the server and the first paint: nothing is known about this browser yet.
  const raw = useSyncExternalStore(subscribe, () => rawStored(storageKey), () => null);
  const stored = useMemo(() => (raw === null ? null : parseStored(raw)), [raw]);
  const [hidden, setHidden] = useState(false);

  const opened = stored?.opened ?? [];
  if (hidden || stored?.dismissed) return null;
  if (stored && !showChecklist(items, { dismissed: false, presentation: false, opened })) return null;

  const done = items.filter((i) => itemDone(i, opened)).length;
  const next = items.find((i) => !itemDone(i, opened));

  function open(item: GettingStartedItem) {
    if (item.done !== null) return;
    const current = parseStored(rawStored(storageKey));
    writeStored(storageKey, { ...current, opened: [...new Set([...(current.opened ?? []), item.key])] });
  }

  function hide() {
    setHidden(true);
    writeStored(storageKey, { ...parseStored(rawStored(storageKey)), dismissed: true });
    void dismissGettingStarted().catch(() => false);
  }

  return (
    <section aria-labelledby="getting-started-title" data-testid="getting-started" className="mb-6 overflow-hidden rounded-panel border border-line/70 bg-card shadow-card">
      <div className="flex items-start gap-3 px-5 pt-4 sm:px-6">
        <div className="min-w-0 flex-1">
          <h2 id="getting-started-title" className="text-base font-semibold text-ink">Getting started</h2>
          <p className="mt-0.5 text-sm text-muted">Your first steps as {roleLabel}. Each one ticks itself once you have done it.</p>
        </div>
        <button
          type="button"
          onClick={hide}
          className="-mr-2 inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-full px-3 text-sm font-semibold text-muted hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-2 focus-visible:outline-strong"
          aria-label="Hide Getting started"
        >
          <X className="size-4" aria-hidden />
          <span>Hide</span>
        </button>
      </div>
      <div className="flex items-center gap-3 px-5 pt-3 pb-2 sm:px-6">
        <span className="text-sm font-semibold whitespace-nowrap text-ink tabular" data-testid="getting-started-progress">{done} of {items.length} done</span>
        <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-ink/[0.07]" aria-hidden>
          <span className="block h-full rounded-full bg-brand transition-[width]" style={{ width: `${Math.round((done / items.length) * 100)}%` }} />
        </span>
      </div>
      <ol className="divide-y divide-line/70 border-t border-line/70" aria-label="First steps">
        {items.map((item) => {
          const isDone = itemDone(item, opened);
          const isNext = next?.key === item.key;
          return (
            <li key={item.key}>
              <Link
                href={item.href}
                onClick={() => open(item)}
                className={cn("flex min-h-12 items-center gap-3 px-5 py-2.5 transition-colors hover:bg-ink/[0.03] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-strong sm:px-6", isNext && "bg-brand-light/40")}
                data-done={isDone ? "true" : "false"}
              >
                {isDone ? <CheckCircle2 className="size-5 shrink-0 text-green-700" aria-hidden /> : <Circle className="size-5 shrink-0 text-muted/60" aria-hidden />}
                <span className="min-w-0 flex-1">
                  <span className={cn("block text-sm font-medium", isDone ? "text-muted" : "text-ink")}>
                    {item.label}
                    <span className="sr-only">{isDone ? " (done)" : ""}</span>
                  </span>
                  {item.hint && !isDone ? <span className="block text-xs text-muted">{item.hint}</span> : null}
                </span>
                {isNext ? (
                  <span className="inline-flex h-9 shrink-0 items-center gap-0.5 rounded-full bg-strong px-3.5 text-sm font-semibold text-white"><span className="pill-text">Start</span><ChevronRight className="size-4" aria-hidden /></span>
                ) : (
                  <ChevronRight className="size-4 shrink-0 text-muted" aria-hidden />
                )}
              </Link>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
