import Link from "next/link";
import { ShieldCheck } from "lucide-react";
import { SafetyBadge } from "@/components/maintenance/bits";
import { MaintenanceTabs } from "@/components/maintenance/tabs";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/states";
import { formatDateTime } from "@/lib/dates";
import { CLEARANCE_STATUSES, type ClearanceStatus, workOrderUnit } from "@/lib/maintenance";
import { can } from "@/lib/permissions";
import { requirePagePermission } from "@/server/auth";
import { listOpenWorkOrders, listRecentClearances, listTrailers, listTrucks, type WorkOrderRow } from "@/server/data/maintenance";
import { getUserNames } from "@/server/data/quotes";
import { businessToday } from "@/server/data/settings";

export const metadata = { title: "Clearance queue" };

const TONE: Record<ClearanceStatus, "amber" | "blue" | "red" | "green"> = { awaiting: "amber", in_progress: "blue", failed: "red", cleared: "green" };

export default async function ClearancePage() {
  const access = await requirePagePermission("maintenance.view");
  const [open, recent, trucks, trailers, people, { timezone }] = await Promise.all([
    listOpenWorkOrders(), listRecentClearances(), listTrucks(), listTrailers(), getUserNames(), businessToday(),
  ]);
  const truckUnits = new Map(trucks.map((t) => [t.id, t.unit_number]));
  const trailerUnits = new Map(trailers.map((t) => [t.id, t.unit_number]));
  const who = (u: string | null) => (u ? people[u] ?? "Former member" : "—");
  const waiting = open.filter((w) => w.status === "awaiting_inspection");
  const groups: Array<{ key: ClearanceStatus; title: string; rows: WorkOrderRow[]; empty: string }> = [
    { key: "awaiting", title: "Awaiting inspection", rows: waiting.filter((w) => w.clearance_status === "awaiting"), empty: "Nothing is waiting." },
    { key: "in_progress", title: "Inspection in progress", rows: waiting.filter((w) => w.clearance_status === "in_progress"), empty: "No inspection is in progress." },
    { key: "failed", title: "Failed inspection — back in the shop", rows: recent.filter((w) => w.clearance_status === "failed" && w.status !== "canceled"), empty: "No failed inspections in the last 14 days." },
    { key: "cleared", title: "Cleared for service (last 14 days)", rows: recent.filter((w) => w.clearance_status === "cleared"), empty: "Nothing cleared in the last 14 days." },
  ];

  return (
    <>
      <PageHeader
        crumbs={[{ label: "Maintenance", href: "/maintenance" }, { label: "Clearance queue" }]}
        title="Clearance queue"
        description={can(access, "maintenance.clear")
          ? "You can inspect and clear trucks. Closing a repair never skips this step for safety-critical work."
          : "Only people allowed to clear vehicles for service record inspections. You can follow the queue here."}
      />
      <MaintenanceTabs active="clearance" />
      <div className="grid gap-5 lg:grid-cols-2">
        {groups.map((g) => (
          <Card key={g.key}>
            <CardHeader title={<span className="flex items-center gap-2">{g.title} <Badge tone={TONE[g.key]}>{g.rows.length}</Badge></span>} />
            {g.rows.length === 0 ? (
              <EmptyState title={g.empty} icon={<ShieldCheck className="size-6" />} />
            ) : (
              <ul className="divide-y divide-line">
                {g.rows.map((w) => (
                  <li key={w.id} className="px-4 py-3 sm:px-5">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link href={`/maintenance/work-orders/${w.id}`} className="font-semibold text-ink hover:underline">{w.number} · {w.title}</Link>
                      {w.safety_critical && <SafetyBadge />}
                    </div>
                    <div className="text-sm text-muted">
                      {workOrderUnit(w, truckUnits, trailerUnits)}
                      {g.key === "in_progress" && ` · inspector ${who(w.inspector_id)}`}
                      {g.key === "cleared" && w.cleared_at && ` · ${who(w.cleared_by)}, ${formatDateTime(w.cleared_at, timezone)}`}
                      {g.key === "failed" && ` · ${who(w.inspector_id)}: ${w.clearance_notes}`}
                      {g.key === "awaiting" && ` · ${CLEARANCE_STATUSES.awaiting.toLowerCase()} since ${formatDateTime(w.updated_at, timezone)}`}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        ))}
      </div>
    </>
  );
}
