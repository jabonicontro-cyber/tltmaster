import Link from "next/link";
import type { ReactNode } from "react";
import { ShieldAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/cn";
import { PM_STATES, STATUS_TONE, WO_STATUSES, WO_URGENCIES, type PmState, type WoStatus, type WoUrgency } from "@/lib/maintenance";

export function WoStatusBadge({ status }: { status: WoStatus }) {
  return <Badge tone={STATUS_TONE[status]}>{WO_STATUSES[status]}</Badge>;
}

export function UrgencyBadge({ urgency }: { urgency: WoUrgency }) {
  return <Badge tone={urgency === "immediate" ? "critical" : urgency === "high" ? "amber" : "gray"}>{WO_URGENCIES[urgency]}</Badge>;
}

export function SafetyBadge() {
  return <Badge tone="critical-soft"><ShieldAlert className="size-3" aria-hidden />Safety-critical</Badge>;
}

export function PmStateBadge({ state }: { state: PmState }) {
  return <Badge tone={state === "overdue" ? "critical" : state === "due_soon" ? "amber" : state === "ok" ? "green" : "gray"}>{PM_STATES[state]}</Badge>;
}

/** An overview number that links to the filtered records behind it. */
export function StatCard({ href, label, value, hint, alert }: { href: string; label: string; value: number | string; hint?: ReactNode; alert?: boolean }) {
  return (
    <Link
      href={href}
      className={cn(
        "group block rounded-panel border border-line/70 bg-card shadow-card p-4 transition-colors hover:border-strong/40 focus-visible:ring-2 focus-visible:ring-strong focus-visible:outline-none",
      )}
    >
      <div className="flex items-center gap-1.5 text-sm font-medium text-muted">{alert && <span className="size-1.5 rounded-full bg-critical" aria-hidden />}{label}</div>
      <div className={cn("mt-1 text-[1.875rem] leading-tight font-semibold tracking-[-0.03em] tabular", alert ? "text-critical" : "text-ink")}>{value}</div>
      {hint && <div className="mt-1 text-xs text-muted">{hint}</div>}
    </Link>
  );
}

export const fmtNum = (n: number | null | undefined, unit = "") =>
  n === null || n === undefined ? "—" : `${n.toLocaleString("en-US", { maximumFractionDigits: 1 })}${unit}`;

export const fmtMoney = (cents: number) => (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
