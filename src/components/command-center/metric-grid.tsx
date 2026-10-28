import Link from "next/link";
import { ChevronRight } from "lucide-react";
import type { MetricCard } from "@/lib/command-center/rules";
import { cn } from "@/lib/cn";

/** A small status dot carries the tone; the rows themselves stay neutral so the numbers do the talking. */
const dotClasses: Record<MetricCard["tone"], string> = {
  default: "bg-line",
  warn: "bg-amber-500",
  bad: "bg-critical",
  good: "bg-green-600",
};

/**
 * Today's operations as one card of rows (owner 2026-10-28: one block instead of a wall of tiles), sitting beside the
 * attention queue. Each row is a way into the module. A null value reads "Not available", never 0.
 */
export function MetricGrid({ cards, columns = 1 }: { cards: MetricCard[]; columns?: 1 | 2 }) {
  return (
    <ul
      className={cn(
        "overflow-hidden rounded-panel bg-card shadow-card ring-1 ring-line/60",
        columns === 2 ? "grid grid-cols-1 sm:grid-cols-2 [&>li]:border-b [&>li]:border-line/70 sm:[&>li:nth-child(odd)]:border-r" : "divide-y divide-line/70",
      )}
      aria-label="Overview"
    >
      {cards.map((c) => {
        const body = (
          <div className={cn("flex items-center gap-3 px-4 py-2.5", c.href && "transition-colors hover:bg-ink/[0.03]")}>
            <span className={cn("size-2 shrink-0 rounded-full", dotClasses[c.tone])} aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-ink">{c.label}</span>
              <span className="block truncate text-xs text-muted">{c.sub}</span>
            </span>
            {c.value === null ? (
              <span className="shrink-0 text-sm font-medium text-muted">Not available</span>
            ) : (
              <span className={cn("shrink-0 text-xl font-semibold tracking-[-0.02em] tabular", c.tone === "bad" ? "text-critical" : c.value === 0 ? "text-muted/70" : "text-ink")}>{c.value}</span>
            )}
            {c.href && <ChevronRight className="size-4 shrink-0 text-muted/60" aria-hidden />}
          </div>
        );
        return (
          <li key={c.key} aria-label={c.label}>
            {c.href ? <Link href={c.href} className="block">{body}</Link> : body}
          </li>
        );
      })}
    </ul>
  );
}
