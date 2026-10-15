import { Badge } from "@/components/ui/badge";
import { directionsNeedAttention, type DirectionsRisk, type DirectionsStatus } from "@/lib/sites";

/**
 * Whether a job site's directions were checked (master plan B51). Safety or access critical directions that nobody
 * verified, and any directions overdue for review, are flagged so nobody relies on them blindly.
 */
export function DirectionsStatusBadge({ status, risk }: { status: DirectionsStatus | null | undefined; risk: DirectionsRisk }) {
  if (!status || status === "none") return null;
  const flag = directionsNeedAttention(status, risk);
  if (status === "verified") return <Badge tone="green">Directions verified</Badge>;
  if (status === "due") return <Badge tone={risk === "safety_access" ? "critical-soft" : "amber"}>Directions due for review</Badge>;
  return <Badge tone={flag ? "critical-soft" : "gray"}>Directions not verified</Badge>;
}

export function DirectionsRiskBadge({ risk }: { risk: DirectionsRisk | null | undefined }) {
  if (risk !== "safety_access") return null;
  return <Badge tone="amber">Safety or access critical</Badge>;
}
