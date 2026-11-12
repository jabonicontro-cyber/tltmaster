import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export interface Stat {
  label: string;
  value: ReactNode;
  /** One line of context under the figure. */
  sub?: ReactNode;
  href?: string;
  /** attention: needs someone (a blue dot); critical: overdue or failed (red dot and figure, fixed red). */
  tone?: "default" | "attention" | "critical";
}

const COLS: Record<number, string> = { 2: "lg:grid-cols-2", 3: "lg:grid-cols-3", 4: "lg:grid-cols-4", 5: "lg:grid-cols-5", 6: "lg:grid-cols-6" };

/**
 * Figures in the website's hairline grid (cells separated by 1px lines, one rounded frame): a quiet label, the figure
 * large and tight, one line of context. Two columns on phones, `columns` on wide screens. Each cell is a list item
 * (the list is named by `label`) and a link when `href` is given. `onNavy` draws it for the navy band. Figures come
 * from real records only; pass "–" with a reason in `sub` when a figure could not be read, never 0.
 */
export function StatGrid({ stats, label, columns = 4, onNavy = false, compact = false, className }: {
  stats: Stat[];
  label: string;
  columns?: 2 | 3 | 4 | 5 | 6;
  onNavy?: boolean;
  /** Smaller figures, for words rather than numbers (a plan name, "Open"). */
  compact?: boolean;
  className?: string;
}) {
  return (
    <ul
      aria-label={label}
      className={cn(
        "grid grid-cols-2 gap-px overflow-hidden rounded-xl max-lg:[&>li:last-child:nth-child(odd)]:col-span-2",
        COLS[columns],
        onNavy ? "bg-white/[0.09] ring-1 ring-white/[0.09]" : "border border-line bg-line",
        className,
      )}
    >
      {stats.map((s) => {
        const body = (
          <>
            <p className={cn("flex items-center gap-1.5 text-[13px] font-medium", onNavy ? "text-silver" : "text-muted")}>
              {s.tone === "attention" || s.tone === "critical" ? <span className={cn("size-1.5 shrink-0 rounded-full", s.tone === "critical" ? "bg-critical" : "bg-electric")} aria-hidden /> : null}
              {s.label}
            </p>
            <p className={cn("mt-2 font-bold tabular", compact ? "text-lg leading-snug tracking-[-0.015em]" : "text-[1.875rem] leading-none tracking-[-0.035em] sm:text-[2.125rem]", onNavy ? "text-cloud" : s.tone === "critical" ? "text-critical" : "text-ink")}>{s.value}</p>
            {s.sub ? <p className={cn("mt-auto pt-2.5 text-xs leading-snug", onNavy ? "text-silver/85" : "text-muted")}>{s.sub}</p> : null}
          </>
        );
        const cell = cn("flex h-full min-w-0 flex-col p-4 sm:p-5", onNavy ? "bg-navy" : "bg-card");
        return (
          <li key={s.label} className={onNavy ? "bg-navy" : "bg-card"}>
            {s.href ? (
              <Link href={s.href} className={cn(cell, "transition-colors duration-150", onNavy ? "hover:bg-navy-2" : "hover:bg-surface")}>
                {body}
              </Link>
            ) : (
              <div className={cell}>{body}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
