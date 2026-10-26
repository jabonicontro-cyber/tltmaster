"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { ArrowRight, Loader2, Search } from "lucide-react";
import { quickSearch, type QuickResults } from "@/app/(app)/search/actions";
import { cn } from "@/lib/cn";

/**
 * Search as you type (owner 2026-10-26): the header pill is a real search box; results appear under it, grouped
 * (customers, orders, tickets, …) and limited to what the person may open (the same server search as the Search page).
 * Arrow keys move, Enter opens, Escape closes, ⌘K / Ctrl+K focuses it from anywhere. "See all results" opens the page.
 * `variant="page"`: the same box on the Search page (phones reach it from the header icon), results listed in place.
 */
export function QuickSearch({ variant = "header", initialQuery = "" }: { variant?: "header" | "page"; initialQuery?: string }) {
  const router = useRouter();
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const seq = useRef(0);
  const [q, setQ] = useState(initialQuery);
  const [open, setOpen] = useState(variant === "page");
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<QuickResults | null>(null);
  const [active, setActive] = useState(-1);

  const hits = (results?.groups ?? []).flatMap((g) => g.hits.map((h) => ({ ...h, group: g.label })));
  const trimmed = q.trim();

  // Debounced search; only the newest answer is shown (older ones may arrive later).
  useEffect(() => {
    const mine = ++seq.current;
    if (trimmed.length < 2 || (variant === "page" && trimmed === initialQuery.trim())) return;
    const t = setTimeout(async () => {
      const r = await quickSearch(trimmed).catch(() => null);
      if (mine !== seq.current) return;
      setResults(r);
      setActive(-1);
      setLoading(false);
    }, 180);
    return () => clearTimeout(t);
  }, [trimmed, variant, initialQuery]);

  // ⌘K / Ctrl+K from anywhere; clicks outside close the header panel.
  useEffect(() => {
    if (variant !== "header") return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        inputRef.current?.focus();
        setOpen(true);
      }
    };
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [variant]);

  const allHref = `/search?q=${encodeURIComponent(trimmed)}`;
  const go = (href: string) => {
    setOpen(variant === "page");
    setActive(-1);
    router.push(href);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActive((i) => Math.min(i + 1, hits.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, -1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (active >= 0 && hits[active]) go(hits[active].href);
      else if (trimmed.length >= 2) go(allHref);
    } else if (e.key === "Escape") {
      if (variant === "header") {
        setOpen(false);
        inputRef.current?.blur();
      } else setQ("");
    }
  };

  // On the Search page the full results for the submitted query are already listed below the box.
  const showPanel = open && trimmed.length >= 2 && !(variant === "page" && trimmed === initialQuery.trim());
  let index = -1;

  return (
    <div ref={boxRef} className={cn("relative", variant === "header" ? "hidden w-64 md:block xl:w-80" : "w-full max-w-2xl")} role="search">
      <label htmlFor={`${listId}-input`} className="sr-only">Search records</label>
      <div className="relative">
        <Search className={cn("pointer-events-none absolute top-1/2 -translate-y-1/2 text-muted", variant === "header" ? "left-4 size-4" : "left-4 size-[18px]")} aria-hidden />
        <input
          ref={inputRef}
          id={`${listId}-input`}
          type="search"
          role="combobox"
          aria-expanded={showPanel}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
          autoComplete="off"
          autoFocus={variant === "page"}
          maxLength={80}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
            // A new query starts with nothing highlighted, so Enter opens the full results.
            setActive(-1);
            setLoading(e.target.value.trim().length >= 2);
          }}
          onFocus={() => {
            setOpen(true);
            setActive(-1);
          }}
          onKeyDown={onKeyDown}
          placeholder={variant === "header" ? "Search records…" : "Order number, customer, PO, ticket, truck, driver…"}
          className={cn(
            "w-full rounded-full border border-line bg-card text-ink shadow-xs transition-colors outline-none placeholder:text-muted hover:border-ink/15 focus:border-strong/40 focus:ring-2 focus:ring-strong/10 [&::-webkit-search-cancel-button]:hidden",
            variant === "header" ? "h-10 pr-12 pl-10 text-sm" : "h-12 pr-4 pl-11 text-[15px]",
          )}
        />
        {variant === "header" && (
          <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2">
            {loading ? <Loader2 className="size-4 animate-spin text-muted" aria-hidden /> : <kbd className="rounded-md border border-line px-1.5 py-px font-sans text-[11px] text-muted">⌘K</kbd>}
          </span>
        )}
      </div>

      {showPanel && (
        <div
          id={listId}
          role="listbox"
          aria-label="Search results"
          className={cn(
            "overflow-y-auto rounded-2xl border border-line/70 bg-card p-1.5",
            variant === "header" ? "ui-pop absolute top-full right-0 z-40 mt-2 max-h-[min(70vh,32rem)] w-[min(32rem,calc(100vw-2rem))] shadow-float" : "mt-3 shadow-card",
          )}
        >
          {results === null ? (
            <p className="px-3 py-3 text-sm text-muted">{loading ? "Searching…" : "Search could not run. Try again."}</p>
          ) : results.groups.length === 0 ? (
            <p className="px-3 py-3 text-sm text-muted">{loading ? "Searching…" : `Nothing found for “${trimmed}”. Only records you may open are searched.`}</p>
          ) : (
            results.groups.map((g) => (
              <div key={g.key} role="group" aria-label={g.label} className="py-1">
                <p className="px-3 pt-1.5 pb-1 text-[11px] font-semibold tracking-[0.06em] text-muted uppercase">{g.label}</p>
                {g.hits.map((h) => {
                  index++;
                  const i = index;
                  return (
                    <Link
                      key={h.id}
                      id={`${listId}-${i}`}
                      role="option"
                      aria-selected={i === active}
                      href={h.href}
                      onClick={() => { setOpen(variant === "page"); setActive(-1); }}
                      onMouseMove={() => active !== i && setActive(i)}
                      className={cn("block rounded-xl px-3 py-2", i === active ? "bg-surface" : "hover:bg-surface")}
                    >
                      <span className="block truncate text-sm font-semibold text-ink">{h.title}</span>
                      {h.detail ? <span className="block truncate text-xs text-muted">{h.detail}</span> : null}
                    </Link>
                  );
                })}
              </div>
            ))
          )}
          <Link href={allHref} onClick={() => { setOpen(variant === "page"); setActive(-1); }} className="mt-1 flex items-center justify-between rounded-xl border-t border-line/70 px-3 py-2.5 text-sm font-semibold text-ink hover:bg-surface">
            See all results for “{trimmed}” <ArrowRight className="size-4" aria-hidden />
          </Link>
        </div>
      )}
    </div>
  );
}
