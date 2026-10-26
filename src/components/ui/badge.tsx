import type { ReactNode } from "react";
import { pillChildren } from "./pill-text";
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

// Pill centring (owner 2026-10-26): a fixed height with the words trimmed to capitals and baseline (pill-text), so the
// text sits in the exact middle in every browser. Words are wrapped in their own span; icons stay beside them.
export function Badge({ tone = "gray", children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex h-[22px] items-center gap-1 rounded-full px-2.5 text-xs font-semibold ring-1 ring-inset whitespace-nowrap align-middle", tones[tone], className)}>
      {pillChildren(children)}
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

/** The solid "Urgent" pill that goes with the red edge (urgent orders, loads and attention items). Fixed red. */
export function UrgentPill({ label = "Urgent" }: { label?: string }) {
  return <span className="inline-flex h-[22px] items-center rounded-full bg-critical px-2.5 text-xs font-semibold text-white align-middle"><span className="pill-text">{label}</span></span>;
}
