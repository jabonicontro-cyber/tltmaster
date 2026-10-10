import { Badge } from "@/components/ui/badge";
import { READINESS_LABELS, type Readiness } from "@/lib/billing/rules";

const tones: Record<Readiness, "gray" | "blue" | "green" | "amber" | "red" | "dark"> = {
  missing_documentation: "red",
  needs_review: "amber",
  blocked: "amber",
  in_progress: "gray",
  ready: "green",
  handed_off: "blue",
};

export function ReadinessBadge({ readiness }: { readiness: Readiness }) {
  return <Badge tone={tones[readiness]}>{READINESS_LABELS[readiness]}</Badge>;
}
