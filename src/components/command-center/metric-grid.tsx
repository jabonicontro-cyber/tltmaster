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
    <ul className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4" aria-label="Overview">
      {cards.map((c) => {
        const body = (
          <div className={cn("flex h-full flex-col rounded-panel border border-line/70 bg-card p-4 shadow-card transition-[border-color,box-shadow,translate] duration-200 sm:p-5", c.href && "hover:-translate-y-px hover:border-ink/15 hover:shadow-float")}>
            <p className="flex items-center gap-1.5 text-[13px] font-medium text-muted">
              {dotClasses[c.tone] && <span className={cn("size-1.5 rounded-full", dotClasses[c.tone])} aria-hidden />}
              {c.label}
            </p>
            {c.value === null ? (
              <p className="mt-1 text-lg font-semibold text-muted">Not available</p>
            ) : (
              <p className={cn("mt-2 text-[2rem] leading-none font-semibold tracking-[-0.03em] tabular", c.tone === "bad" ? "text-critical" : "text-ink")}>{c.value}</p>
            )}
            <p className="mt-auto pt-3 text-sm text-muted">{c.sub}</p>
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
