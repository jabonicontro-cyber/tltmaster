import { Badge } from "@/components/ui/badge";
import { TICKET_STATUS_LABELS, type TicketStatus } from "@/lib/tickets/rules";

const tones: Record<TicketStatus, "gray" | "blue" | "green" | "amber" | "red"> = {
  submitted: "blue",
  needs_review: "amber",
  accepted: "green",
  voided: "gray",
  superseded: "gray",
};

export function TicketStatusBadge({ status }: { status: TicketStatus }) {
  return (
    <Badge tone={tones[status]} className={status === "voided" ? "line-through" : undefined}>
      {TICKET_STATUS_LABELS[status]}
    </Badge>
  );
}
