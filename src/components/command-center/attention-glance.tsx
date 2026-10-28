import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/cn";

export interface AttentionKindRow {
  kind: string;
  label: string;
  count: number;
  urgent: number;
  /** Who fixes it (e.g. "Office (billing)"). */
  owner: string;
  /** The oldest or most urgent example, when it is on the first page of the queue. */
  example?: string;
  href: string;
}

/**
 * The attention queue at a glance (owner 2026-10-28): one row per kind of problem with its count, urgent ones first,
 * each opening that kind's full queue. Same row language as "Operations today" so the page reads as one system.
 */
export function AttentionGlance({ rows }: { rows: AttentionKindRow[] }) {
  return (
    <ul className="divide-y divide-line/70" aria-label="Attention by kind">
      {rows.map((r) => (
        <li key={r.kind} aria-label={r.label}>
          <Link href={r.href} className="flex items-center gap-3 px-5 py-3 transition-colors hover:bg-ink/[0.03] sm:px-6">
            <span className={cn("size-2 shrink-0 rounded-full", r.urgent ? "bg-critical" : "bg-amber-500")} aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-x-2 text-sm font-medium text-ink">
                {r.label}
                {r.urgent > 0 && <span className="inline-flex h-[20px] items-center rounded-full bg-critical px-2 text-[11px] font-semibold text-white"><span className="pill-text">{r.urgent} urgent</span></span>}
              </span>
              <span className="block truncate text-xs text-muted">{r.example ? `${r.example} · ` : ""}{r.owner}</span>
            </span>
            <span className={cn("shrink-0 text-xl font-semibold tracking-[-0.02em] tabular", r.urgent ? "text-critical" : "text-ink")}>{r.count}</span>
            <ChevronRight className="size-4 shrink-0 text-muted/60" aria-hidden />
          </Link>
        </li>
      ))}
    </ul>
  );
}
