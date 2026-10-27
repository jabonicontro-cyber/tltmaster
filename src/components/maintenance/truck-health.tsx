import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { HEALTH_LABELS, type HealthLevel } from "@/lib/fleet/health";
import type { TruckHealthRow } from "@/server/data/truck-health";

// Truck health (B93): every truck at Watch or At risk, most serious first, each with the reasons behind its level.

export function HealthBadge({ level }: { level: HealthLevel }) {
  return <Badge tone={level === "at_risk" ? "critical-soft" : level === "watch" ? "amber" : "green"}>{HEALTH_LABELS[level]}</Badge>;
}

export function TruckHealthCard({ rows, canSetRules }: { rows: TruckHealthRow[]; canSetRules: boolean }) {
  const flagged = rows.filter((r) => r.level !== "good").sort((a, b) => (a.level === b.level ? a.unit_number.localeCompare(b.unit_number, undefined, { numeric: true }) : a.level === "at_risk" ? -1 : 1));
  const good = rows.length - flagged.length;
  return (
    <section aria-label="Truck health" className="mb-5">
      <Card>
        <CardHeader
          title="Truck health"
          description={`${good} of ${rows.length} truck${rows.length === 1 ? "" : "s"} Good. From open defects, unplanned repairs in the last 90 days, open repairs and overdue service${canSetRules ? " — rules in Settings → Dispatch rules" : ""}. Information only: safety restrictions are what block dispatch.`}
        />
        {flagged.length === 0 ? (
          <CardBody><p className="text-sm text-muted">Every truck reads Good.</p></CardBody>
        ) : (
          <ul className="divide-y divide-line/70 border-t border-line/70" aria-label="Trucks to watch">
            {flagged.map((r) => (
              <li key={r.truck_id}>
                <Link href={`/fleet/trucks/${r.truck_id}`} className="grid grid-cols-[5rem_6rem_minmax(0,1fr)] items-center gap-3 px-5 py-2.5 text-sm hover:bg-surface sm:px-6">
                  <span className="font-semibold">{r.unit_number}</span>
                  <span><HealthBadge level={r.level} /></span>
                  <span className="text-muted">{r.reasons.join(" · ")}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </section>
  );
}
