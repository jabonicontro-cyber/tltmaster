import Link from "next/link";
import type { MetricCard } from "@/lib/command-center/rules";
import { cn } from "@/lib/cn";

const toneClasses: Record<MetricCard["tone"], string> = {
  default: "border-line",
  warn: "border-amber-300",
  bad: "border-brand",
  good: "border-green-300",
};

/** Overview cards. A null value reads "Not available", never 0. */
export function MetricGrid({ cards }: { cards: MetricCard[] }) {
  return (
    <ul className="grid grid-cols-2 gap-2 sm:gap-3 xl:grid-cols-4" aria-label="Overview">
      {cards.map((c) => {
        const body = (
          <div className={cn("flex h-full flex-col rounded-lg border border-l-4 bg-white p-3 sm:p-4 shadow-xs transition-colors", toneClasses[c.tone], c.href && "hover:bg-surface/60")}>
            <p className="text-sm font-semibold text-muted">{c.label}</p>
            {c.value === null ? (
              <p className="mt-1 text-lg font-bold text-muted">Not available</p>
            ) : (
              <p className={cn("text-2xl font-black tabular sm:text-3xl", c.tone === "bad" ? "text-brand" : "text-ink")}>{c.value}</p>
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
