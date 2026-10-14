import Link from "next/link";
import { ReturnLink } from "@/components/ui/return-link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { EquipmentActions } from "@/components/fleet/equipment-actions";
import { CapacityCard, EquipmentDetails, EquipmentHistory, ServiceCard } from "@/components/fleet/equipment-views";
import { ServiceStatusBadge } from "@/components/fleet/fleet-badges";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { FlashToast } from "@/components/ui/flash-toast";
import { PageHeader } from "@/components/ui/page-header";
import { TRAILER_TYPE_LABELS, TRUCK_TYPE_LABELS } from "@/lib/fleet/labels";
import { can } from "@/lib/permissions";
import { requirePagePermission } from "@/server/auth";
import { documentRules, fleetContext, getTruck, truckOptions, vehicleRecords } from "@/server/data/fleet";
import { downtimeDays, vehicleAvailability } from "@/lib/fleet/availability";
import { AssignmentCard, AvailabilityCard, CostsCard, DocumentsCard, MaintenanceCard, OwnershipCard } from "@/components/fleet/vehicle-sections";
import { createClient } from "@/server/supabase/server";
import { businessToday } from "@/server/data/settings";

export const metadata = { title: "Truck" };

export default async function TruckPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ back?: string }> }) {
  const { back } = await searchParams;
  const access = await requirePagePermission("fleet.view");
  const { id } = await params;
  const detail = await getTruck(id);
  if (!detail) notFound();
  const { truck: t, events, audit, pairedTrailers, names } = detail;
  const { timezone, today } = await businessToday();
  const who = (uid: string | null) => (uid ? names[uid] ?? "Former user" : "System");
  const seeMaintenance = can(access, "maintenance.view");
  const [ctx, records, trucks, driverRows, rules] = await Promise.all([
    fleetContext({ maintenance: seeMaintenance }),
    vehicleRecords("truck", t.id, { maintenance: seeMaintenance, costs: can(access, "maintenance.costs") }),
    truckOptions(),
    (await createClient()).from("drivers").select("id, name, primary_truck_id").eq("active", true).order("name"),
    documentRules(),
  ]);
  const availability = vehicleAvailability(t, ctx.maintenance.openByTruck.get(t.id) ?? [], today);
  const restricted = availability.state === "restricted" || availability.state === "awaiting_clearance";
  const unit = new Map(trucks.map((x) => [x.id, x.unit_number]));
  const drivers = ((driverRows.data ?? []) as Array<{ id: string; name: string; primary_truck_id: string | null }>).map((d) => ({ id: d.id, name: d.name, truck: d.primary_truck_id ? unit.get(d.primary_truck_id) ?? null : null }));
  const safetyWo = (ctx.maintenance.openByTruck.get(t.id) ?? []).find((w) => w.safety_critical);

  return (
    <>
      <Suspense>
        <FlashToast messages={{ saved: { text: "Truck saved." } }} />
      </Suspense>
      <ReturnLink back={back} />
      <PageHeader
        title={`Truck ${t.unit_number}`}
        crumbs={[{ label: "Fleet", href: "/fleet" }, { label: "Trucks", href: "/fleet/trucks" }, { label: t.unit_number }]}
        badges={
          <>
            <ServiceStatusBadge status={t.service_status} active={t.active} />
            <Badge tone="gray">{TRUCK_TYPE_LABELS[t.truck_type]}</Badge>
          </>
        }
        description={[t.model_year, t.make, t.model].filter(Boolean).join(" ") || undefined}
        actions={
          <EquipmentActions
            kind="truck"
            id={t.id}
            unitNumber={t.unit_number}
            active={t.active}
            status={t.service_status}
            today={today}
            permissions={{ edit: can(access, "fleet.edit"), service: can(access, "fleet.service") }}
            clearanceRequired={safetyWo ? `/maintenance/work-orders/${safetyWo.id}` : undefined}
          />
        }
      />
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
        <div className="space-y-5 xl:col-span-2">
          <AvailabilityCard a={availability} timezone={timezone} />
          <ServiceCard e={t} timezone={timezone} />
          <AssignmentCard truckId={t.id} current={ctx.driverByTruck.get(t.id) ?? null} drivers={drivers} history={records.assignments} names={records.driverNames} canAssign={can(access, "fleet.assign") && t.active} restricted={restricted} timezone={timezone} who={who} />
          <MaintenanceCard vehicleId={t.id} records={records} canSee={seeMaintenance} canCreate={can(access, "maintenance.manage")} timezone={timezone} />
          <DocumentsCard vehicle={{ kind: "truck", id: t.id }} docs={records.documents} today={today} canEdit={can(access, "fleet.edit")} timezone={timezone} rules={rules} />
          <CostsCard records={records} downtime90={downtimeDays(events, t, new Date(), 90)} canSeeCosts={can(access, "maintenance.costs")} />
          <CapacityCard e={t} timezone={timezone} who={who} />
          <EquipmentDetails e={t} timezone={timezone} who={who} />
          <OwnershipCard vehicle={{ kind: "truck", id: t.id }} value={t.ownership} canEdit={can(access, "fleet.edit")} />
          <Card>
            <CardHeader title="Trailers usually paired with this truck" description="Each trailer keeps its own service status." />
            <CardBody>
              {pairedTrailers.length === 0 ? (
                <p className="text-sm text-muted">None.</p>
              ) : (
                <ul className="space-y-2">
                  {pairedTrailers.map((r) => (
                    <li key={r.id} className="flex flex-wrap items-center gap-2">
                      <Link href={`/fleet/trailers/${r.id}`} className="font-semibold hover:underline">{r.unit_number}</Link>
                      <span className="text-sm text-muted">{TRAILER_TYPE_LABELS[r.trailer_type]}</span>
                      <ServiceStatusBadge status={r.service_status} active={r.active} />
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>
        </div>
        <EquipmentHistory events={events} audit={audit} timezone={timezone} who={who} />
      </div>
    </>
  );
}
