import Link from "next/link";
import { FleetNav } from "@/components/fleet/fleet-nav";
import { InspectionForm } from "@/components/fleet/inspection-form";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState, Notice } from "@/components/ui/states";
import { addDays, formatDate } from "@/lib/dates";
import { itemLabel, KIND_LABEL, type InspectionKind } from "@/lib/inspections/items";
import { can } from "@/lib/permissions";
import { requirePagePermission } from "@/server/auth";
import { truckOptions } from "@/server/data/fleet";
import { loadInspections } from "@/server/data/inspections";
import { businessToday } from "@/server/data/settings";

export const metadata = { title: "Inspections" };

const DAYS = 14;

/**
 * Digital inspections (B132): drivers' pre-trip and post-trip inspections on the standard DVIR items. Defects open
 * work orders; a safety defect takes the truck out of service. A truck working today without a pre-trip is flagged
 * here and on the dispatch board — flagged, never blocked (owner 2026-11-02).
 */
export default async function InspectionsPage() {
  const access = await requirePagePermission("fleet.view");
  const { today } = await businessToday();
  const [data, trucks] = await Promise.all([loadInspections(addDays(today, -(DAYS - 1)), true), truckOptions()]);
  const header = (
    <>
      <PageHeader title="Fleet" description="Trucks, trailers and drivers, with what makes each one ready — or not ready — for work." />
      <FleetNav active="Inspections" />
    </>
  );
  if (!data.installed) return <>{header}<Notice title="Not available yet">Inspections need a database update that has not been installed yet.</Notice></>;
  const edit = can(access, "fleet.edit");
  const doneToday = new Map<string, Set<InspectionKind>>();
  for (const r of data.rows.filter((r) => r.inspected_on === today)) doneToday.set(r.truck_id, (doneToday.get(r.truck_id) ?? new Set()).add(r.kind));
  const formTrucks = trucks.filter((t) => t.active && t.service_status === "in_service")
    .map((t) => ({ id: t.id, label: t.unit_number, pending: (["pre_trip", "post_trip"] as const).filter((k) => !doneToday.get(t.id)?.has(k)) }))
    .filter((t) => t.pending.length > 0);
  const defects = data.rows.filter((r) => r.defect_count > 0);

  return (
    <>
      {header}
      <Card className="mb-5">
        <CardHeader title="Pre-trip missing today" description="Trucks with a load today and no pre-trip inspection yet. They are not blocked; remind the driver." />
        {data.missing.length === 0 ? <CardBody><EmptyState title="Every working truck has its pre-trip" /></CardBody> : (
          <ul className="flex flex-wrap gap-2 border-t border-line px-5 py-4 sm:px-6" aria-label="Pre-trip missing today">
            {data.missing.map((m) => <li key={m.truck_id}><Link href={`/fleet/trucks/${m.truck_id}`}><Badge tone="amber">Truck {m.unit}</Badge></Link></li>)}
          </ul>
        )}
      </Card>

      <div className="mb-5 grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader title={`Defects — last ${DAYS} days`} description="Each opened a work order for the shop." />
          {defects.length === 0 ? <CardBody><EmptyState title="No defects reported" /></CardBody> : (
            <ul className="divide-y divide-line border-t border-line" aria-label="Defects">
              {defects.map((r) => (
                <li key={r.id} className="px-5 py-3 text-sm sm:px-6">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold">Truck {r.truck?.unit_number ?? "—"}</span>
                    <span className="text-muted">{formatDate(r.inspected_on)} · {KIND_LABEL[r.kind]}{r.driver ? ` · ${r.driver.name}` : ""}</span>
                    {r.safety_defect && <Badge tone="critical">Safety</Badge>}
                    {r.work_order && <Link href={`/maintenance/work-orders/${r.work_order.id}`} className="ml-auto font-semibold text-brand-fg hover:underline">{r.work_order.number}</Link>}
                  </div>
                  <p className="mt-1 text-muted">{r.items.filter((i) => !i.ok).map((i) => `${itemLabel(i.key)}: ${i.note}`).join(" · ")}</p>
                </li>
              ))}
            </ul>
          )}
        </Card>
        {edit && (
          <Card>
            <CardHeader title="Record an inspection" description="Drivers do this on My Day; the office can record one for today." />
            <CardBody>{formTrucks.length ? <InspectionForm trucks={formTrucks.map((t) => ({ ...t, label: `Truck ${t.label}` }))} /> : <EmptyState title="Every truck in service is inspected today" />}</CardBody>
          </Card>
        )}
      </div>

      <Card>
        <CardHeader title={`All inspections — last ${DAYS} days`} />
        {data.rows.length === 0 ? <CardBody><EmptyState title="No inspections yet" description="Drivers record pre-trip and post-trip inspections on My Day." /></CardBody> : (
          <ul className="divide-y divide-line border-t border-line" aria-label="Inspections">
            {data.rows.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-2.5 text-sm sm:px-6">
                <span className="w-24 text-muted">{formatDate(r.inspected_on)}</span>
                <span className="font-semibold">Truck {r.truck?.unit_number ?? "—"}</span>
                <span className="min-w-0 flex-1 text-muted">{KIND_LABEL[r.kind]}{r.driver ? ` · ${r.driver.name}` : " · Office"}{r.odometer !== null ? ` · ${r.odometer.toLocaleString("en-US")} mi` : ""}</span>
                {r.defect_count === 0 ? <Badge tone="green">No defects</Badge> : <Badge tone={r.safety_defect ? "critical" : "amber"}>{r.defect_count} defect{r.defect_count > 1 ? "s" : ""}</Badge>}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
