import { TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/cn";
import { DRIVING_NOTICE, PRESENCE, WORK_STATUS, type Presence, type WorkStatus } from "@/lib/communications";

const DOT: Record<Presence, string> = {
  available: "bg-green-600",
  busy: "bg-amber-500",
  away: "bg-gray-400",
};

/** A small presence dot with an accessible label. Unknown (never seen) shows a hollow dot. */
export function PresenceDot({ presence, className }: { presence: Presence | null; className?: string }) {
  const label = presence ? PRESENCE[presence] : "Presence unknown";
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cn("inline-block size-2.5 shrink-0 rounded-full ring-2 ring-card", presence ? DOT[presence] : "border border-muted bg-transparent", className)}
    />
  );
}

/** Work status from Taviron's own records. "Unknown" is shown as such, never as available. */
export function WorkStatusBadge({ status }: { status: WorkStatus }) {
  if (status === "unknown") return <span className="text-xs text-muted">Work status unknown</span>;
  return <Badge tone={status === "active_delivery" ? "amber" : "gray"}>{WORK_STATUS[status]}</Badge>;
}

/** Shown wherever a recipient may be driving. */
export function DrivingNotice({ names, className }: { names: string[]; className?: string }) {
  if (names.length === 0) return null;
  return (
    <div role="note" className={cn("flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950", className)}>
      <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
      <p>
        <span className="font-semibold">{names.length === 1 ? names[0] : `${names.length} people`} on an active delivery.</span> {DRIVING_NOTICE}
      </p>
    </div>
  );
}
