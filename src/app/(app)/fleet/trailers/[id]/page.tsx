import Link from "next/link";
import { ReturnLink } from "@/components/ui/return-link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { EquipmentActions } from "@/components/fleet/equipment-actions";
import { CapacityCard, CompatibilityText, EquipmentDetails, EquipmentHistory, ServiceCard } from "@/components/fleet/equipment-views";
import { ServiceStatusBadge } from "@/components/fleet/fleet-badges";
import { Badge } from "@/components/ui/badge";
import { FlashToast } from "@/components/ui/flash-toast";
import { PageHeader } from "@/components/ui/page-header";
import { TRAILER_TYPE_LABELS } from "@/lib/fleet/labels";
import { can } from "@/lib/permissions";
import { requirePagePermission } from "@/server/auth";
import { getTrailer } from "@/server/data/fleet";
import { businessToday } from "@/server/data/settings";

export const metadata = { title: "Trailer" };

export default async function TrailerPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ back?: string }> }) {
  const { back } = await searchParams;
  const access = await requirePagePermission("fleet.view");
  const { id } = await params;
  const detail = await getTrailer(id);
  if (!detail) notFound();
  const { trailer: t, events, audit, defaultTruck, names } = detail;
  const { timezone, today } = await businessToday();
  const who = (uid: string | null) => (uid ? names[uid] ?? "Former user" : "System");

  return (
    <>
      <Suspense>
        <FlashToast messages={{ saved: { text: "Trailer saved." } }} />
      </Suspense>
      <ReturnLink back={back} />
      <PageHeader
        title={`Trailer ${t.unit_number}`}
        crumbs={[{ label: "Fleet", href: "/fleet" }, { label: "Trailers", href: "/fleet/trailers" }, { label: t.unit_number }]}
        badges={
          <>
            <ServiceStatusBadge status={t.service_status} active={t.active} />
            <Badge tone="gray">{TRAILER_TYPE_LABELS[t.trailer_type]}</Badge>
          </>
        }
        description={[t.model_year, t.make, t.model].filter(Boolean).join(" ") || undefined}
        actions={
          <EquipmentActions
            kind="trailer"
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
          <EquipmentDetails
            e={t}
            timezone={timezone}
            who={who}
            extra={[
              { label: "Can be pulled by", value: <CompatibilityText types={t.compatible_truck_types} /> },
              {
                label: "Usually paired with",
                value: defaultTruck ? (
                  <span className="inline-flex flex-wrap items-center gap-2">
                    <Link href={`/fleet/trucks/${defaultTruck.id}`} className="font-semibold hover:underline">Truck {defaultTruck.unit_number}</Link>
                    <ServiceStatusBadge status={defaultTruck.service_status} active={defaultTruck.active} />
                  </span>
                ) : (
                  ""
                ),
              },
              { label: "Compatibility notes", value: t.compatibility_notes, wide: true },
            ]}
          />
        </div>
        <EquipmentHistory events={events} audit={audit} timezone={timezone} who={who} />
      </div>
    </>
  );
}
