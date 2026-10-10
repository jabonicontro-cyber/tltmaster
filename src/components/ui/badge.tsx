import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { QUOTE_STATUS_LABELS, type QuoteStatus } from "@/lib/quotes/status";

type Tone = "gray" | "blue" | "green" | "amber" | "red" | "dark" | "brand";

const tones: Record<Tone, string> = {
  gray: "bg-gray-100 text-gray-700 ring-gray-300",
  blue: "bg-blue-50 text-blue-800 ring-blue-200",
  green: "bg-green-50 text-green-800 ring-green-200",
  amber: "bg-amber-50 text-amber-900 ring-amber-200",
  red: "bg-red-50 text-red-800 ring-red-200",
  dark: "bg-charcoal text-white ring-charcoal",
  brand: "bg-brand-light text-brand-dark ring-red-200",
};

export function Badge({ tone = "gray", children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-semibold ring-1 ring-inset whitespace-nowrap", tones[tone], className)}>
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
    <Badge tone="dark" className="tracking-wide">
      SAMPLE
    </Badge>
  );
}

export function ActiveBadge({ active }: { active: boolean }) {
  return active ? <Badge tone="green">Active</Badge> : <Badge tone="gray">Archived</Badge>;
}
