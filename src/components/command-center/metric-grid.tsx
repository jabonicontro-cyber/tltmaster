import Link from "next/link";
import type { MetricCard } from "@/lib/command-center/rules";
import { cn } from "@/lib/cn";

/** A small status dot carries the tone; the cards themselves stay neutral so the numbers do the talking. */
const dotClasses: Record<MetricCard["tone"], string> = {
  default: "",
  warn: "bg-amber-500",
  bad: "bg-critical",
  good: "bg-green-600",
};

/** Overview cards. A null value reads "Not available", never 0. */
export function MetricGrid({ cards }: { cards: MetricCard[] }) {
  return (
    <ul className="grid grid-cols-2 gap-2 sm:gap-3 xl:grid-cols-4" aria-label="Overview">
      {cards.map((c) => {
        const body = (
          <div className={cn("flex h-full flex-col rounded-lg border border-line bg-card p-3 sm:p-4 transition-colors", c.href && "hover:border-strong/40 hover:bg-surface/40")}>
            <p className="flex items-center gap-1.5 text-[13px] font-medium text-muted">
              {dotClasses[c.tone] && <span className={cn("size-1.5 rounded-full", dotClasses[c.tone])} aria-hidden />}
              {c.label}
            </p>
            {c.value === null ? (
              <p className="mt-1 text-lg font-semibold text-muted">Not available</p>
            ) : (
              <p className={cn("mt-1 text-2xl font-semibold tracking-tight tabular sm:text-[1.75rem]", c.tone === "bad" ? "text-critical" : "text-ink")}>{c.value}</p>
            )}
            <p className="mt-auto pt-1 text-sm text-muted">{c.sub}</p>
          </div>
        );
        return (
          <li key={c.key} aria-label={c.label}>
            {c.href ? <Link href={c.href} className="block h-full">{body}</Link> : body}
          </li>
        );
      })}
    </ul>
  );
}
