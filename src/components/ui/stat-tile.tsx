import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * A headline figure (owner's references 2026-10-27: numbers first, words second): a tinted icon chip, a quiet label,
 * the figure large and tight, and one line of context below. The tone colours only the chip and, for "critical",
 * the figure — urgency keeps the fixed critical red, never the company's colour.
 */
export type StatTone = "brand" | "critical" | "amber" | "green" | "neutral";

const chip: Record<StatTone, string> = {
  brand: "bg-brand-light text-brand-fg",
  critical: "bg-red-50 text-critical",
  amber: "bg-amber-50 text-amber-700",
  green: "bg-green-50 text-green-700",
  neutral: "bg-ink/[0.05] text-muted",
};

export function StatTile({ icon, tone = "neutral", label, value, muted = false, children, className }: {
  icon: ReactNode;
  tone?: StatTone;
  label: string;
  value: ReactNode;
  /** A zero or empty figure: shown quieter so the figures that matter stand out. */
  muted?: boolean;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex min-w-0 flex-col rounded-panel bg-card p-4 shadow-card ring-1 ring-line/60 sm:p-5", className)}>
      <div className="flex items-center gap-2.5">
        <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-full [&_svg]:size-4", chip[tone])} aria-hidden>{icon}</span>
        <p className="min-w-0 text-sm leading-tight font-medium text-muted">{label}</p>
      </div>
      <p className={cn("mt-3 text-[2rem] leading-none sm:mt-4 sm:text-[2.5rem] font-semibold tracking-[-0.035em] tabular", muted ? "text-muted/70" : tone === "critical" ? "text-critical" : "text-ink")} aria-hidden>{value}</p>
      {children && <div className="mt-2.5 min-h-[26px] text-[13px] sm:mt-3 sm:text-sm">{children}</div>}
    </div>
  );
}
