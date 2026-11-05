import { Badge } from "@/components/ui/badge";
import { READINESS_LABELS, type Readiness } from "@/lib/billing/rules";
import { getSay } from "@/server/industry";

const tones: Record<Readiness, "gray" | "blue" | "green" | "amber" | "red" | "dark"> = {
  missing_documentation: "red",
  needs_review: "amber",
  blocked: "amber",
  in_progress: "gray",
  ready: "green",
  handed_off: "blue",
};

export async function ReadinessBadge({ readiness }: { readiness: Readiness }) {
  const say = await getSay();
  return <Badge tone={tones[readiness]}>{say(READINESS_LABELS[readiness])}</Badge>;
}
