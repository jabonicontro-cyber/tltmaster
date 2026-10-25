import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { QUOTE_STATUS_LABELS, type QuoteStatus } from "@/lib/quotes/status";
import { ORDER_STATUS_LABELS } from "@/lib/orders/status";
import type { OrderStatus } from "@/server/data/types";

type Tone = "gray" | "blue" | "green" | "amber" | "red" | "dark" | "brand" | "critical" | "critical-soft";

const tones: Record<Tone, string> = {
  gray: "bg-ink/[0.06] text-ink/75 ring-transparent",
  blue: "bg-blue-50 text-blue-800 ring-blue-100",
  green: "bg-green-50 text-green-800 ring-green-100",
  amber: "bg-amber-50 text-amber-900 ring-amber-100",
  red: "bg-red-50 text-red-800 ring-red-100",
  dark: "bg-strong text-white ring-strong",
  brand: "bg-brand-light text-brand-fg ring-brand/25",
  // Urgent and safety states: fixed red, never the company's brand colour.
  critical: "bg-critical text-white ring-critical",
  "critical-soft": "bg-red-50 text-critical ring-red-100",
};

// Optical centring (measured 2026-10-25): with Inter, lowercase text sits about 0.75 px low in a symmetric pill, so the
// text is lifted half a pixel: 2 px above and 3 px below (21 px tall), which the browser renders as a true half-pixel lift.
export function Badge({ tone = "gray", children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full px-2.5 pt-0.5 pb-[3px] text-xs leading-4 font-semibold ring-1 ring-inset whitespace-nowrap", tones[tone], className)}>
      {children}
    </span>
  );
}

const quoteTones: Record<QuoteStatus, Tone> = {
  draft: "gray",
  sent: "blue",
  accepted: "green",
  declined: "amber",
  expired: "amber",
  canceled: "gray",
};

export function QuoteStatusBadge({ status }: { status: QuoteStatus }) {
  return (
    <Badge tone={quoteTones[status]} className={status === "canceled" ? "line-through" : undefined}>
      {QUOTE_STATUS_LABELS[status]}
    </Badge>
  );
}

export function SampleBadge({ show = true }: { show?: boolean }) {
  if (!show) return null;
  return (
    <Badge tone="gray" className="bg-transparent text-[11px] text-muted">
      Sample
    </Badge>
  );
}

export function ActiveBadge({ active }: { active: boolean }) {
  return active ? <Badge tone="green">Active</Badge> : <Badge tone="gray">Archived</Badge>;
}

const orderTones: Record<OrderStatus, Tone> = {
  draft: "gray",
  confirmed: "blue",
  scheduled: "blue",
  dispatched: "amber",
  in_progress: "amber",
  partially_completed: "amber",
  completed: "green",
  on_hold: "red",
  canceled: "gray",
};

export function OrderStatusBadge({ status }: { status: OrderStatus }) {
  return (
    <Badge tone={orderTones[status]} className={status === "canceled" ? "line-through" : undefined}>
      {ORDER_STATUS_LABELS[status]}
    </Badge>
  );
}
