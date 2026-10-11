import { ShieldAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/dates";
import type { Availability, DocumentState } from "@/lib/fleet/availability";

const AVAILABILITY_TONE = {
  inactive: "gray",
  awaiting_clearance: "critical-soft",
  restricted: "critical",
  out_of_service: "red",
  in_shop: "amber",
  available: "green",
} as const;

export function AvailabilityBadge({ a }: { a: Availability }) {
  return (
    <Badge tone={AVAILABILITY_TONE[a.state]}>
      {(a.state === "restricted" || a.state === "awaiting_clearance") && <ShieldAlert className="size-3" aria-hidden />}
      {a.label}
    </Badge>
  );
}

export function DocumentStateBadge({ state, expiresOn }: { state: DocumentState; expiresOn: string | null }) {
  if (state === "expired") return <Badge tone="red">Expired {formatDate(expiresOn)}</Badge>;
  if (state === "expiring") return <Badge tone="amber">Expires {formatDate(expiresOn)}</Badge>;
  if (state === "valid") return <Badge tone="green">Valid to {formatDate(expiresOn)}</Badge>;
  return <Badge tone="gray">No expiry recorded</Badge>;
}
