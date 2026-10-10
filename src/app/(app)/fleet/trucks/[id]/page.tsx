import Link from "next/link";
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
import { getTruck } from "@/server/data/fleet";
import { businessToday } from "@/server/data/settings";

export const metadata = { title: "Truck" };

export default async function TruckPage({ params }: { params: Promise<{ id: string }> }) {
  const access = await requirePagePermission("fleet.view");
  const { id } = await params;
  const detail = await getTruck(id);
  if (!detail) notFound();
  const { truck: t, events, audit, pairedTrailers, names } = detail;
  const { timezone, today } = await businessToday();
  const who = (uid: string | null) => (uid ? names[uid] ?? "Former user" : "System");

  return (
    <>
      <Suspense>
        <FlashToast messages={{ saved: { text: "Truck saved." } }} />
      </Suspense>
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
          />
        }
      />
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
        <div className="space-y-5 xl:col-span-2">
          <ServiceCard e={t} timezone={timezone} />
          <CapacityCard e={t} timezone={timezone} who={who} />
          <EquipmentDetails e={t} timezone={timezone} who={who} />
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
