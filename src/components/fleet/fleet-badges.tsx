import { AlertTriangle, CheckCircle2, HelpCircle, Wrench } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/dates";
import { capacityState, formatCapacity, type CapacityFields } from "@/lib/fleet/labels";
import type { EligibilityResult } from "@/lib/fleet/eligibility";
import type { ServiceStatus } from "@/server/data/types";

export function ServiceStatusBadge({ status, active = true }: { status: ServiceStatus; active?: boolean }) {
  if (!active) return <Badge tone="gray">Inactive</Badge>;
  return status === "in_service" ? (
    <Badge tone="green">In service</Badge>
  ) : (
    <Badge tone="red">
      <Wrench className="size-3" aria-hidden /> Out of service
    </Badge>
  );
}

/** Capacity with an explicit "unknown" / "not verified" state — never a guessed value. */
export function CapacityText({ e }: { e: CapacityFields }) {
  const text = formatCapacity(e);
  const state = capacityState(e);
  if (state === "unknown")
    return (
      <span className="inline-flex items-center gap-1 text-muted">
        <HelpCircle className="size-3.5" aria-hidden /> Unknown
      </span>
    );
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <span className="tabular">{text}</span>
      {state === "verified" ? <Badge tone="green">Verified</Badge> : <Badge tone="amber">Not verified</Badge>}
    </span>
  );
}

export function ReadinessBadge({ readiness }: { readiness: EligibilityResult }) {
  if (!readiness.eligible)
    return (
      <Badge tone="red">
        <AlertTriangle className="size-3" aria-hidden /> Not eligible
      </Badge>
    );
  if (readiness.warnings.length)
    return (
      <Badge tone="amber">
        <AlertTriangle className="size-3" aria-hidden /> Eligible — check
      </Badge>
    );
  return (
    <Badge tone="green">
      <CheckCircle2 className="size-3" aria-hidden /> Eligible
    </Badge>
  );
}

/** Status of one qualification on a date. */
export function QualificationBadge({ q, today, soon }: { q: { expires_on: string | null; verified_at: string | null }; today: string; soon: string }) {
  if (q.expires_on === null) return <Badge tone="amber">Expiry unknown</Badge>;
  if (q.expires_on < today) return <Badge tone="red">Expired {formatDate(q.expires_on)}</Badge>;
  const expiry = q.expires_on <= soon ? <Badge tone="amber">Expires {formatDate(q.expires_on)}</Badge> : <Badge tone="gray">Expires {formatDate(q.expires_on)}</Badge>;
  return (
    <span className="inline-flex flex-wrap gap-1.5">
      {expiry}
      {q.verified_at ? <Badge tone="green">Verified</Badge> : <Badge tone="amber">Not verified</Badge>}
    </span>
  );
}
