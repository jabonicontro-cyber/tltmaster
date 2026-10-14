import { notFound } from "next/navigation";
import { ReturnLink } from "@/components/ui/return-link";
import { CalendarRange, ClipboardList, Truck, Wrench } from "lucide-react";
import { ReportActions } from "@/components/field-reports/report-actions";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { DescriptionList } from "@/components/ui/description-list";
import { PageHeader } from "@/components/ui/page-header";
import { formatDate, formatDateTime } from "@/lib/dates";
import { REPORT_KIND_LABELS } from "@/lib/driver/rules";
import { can } from "@/lib/permissions";
import { requirePagePermission } from "@/server/auth";
import { getFieldReport } from "@/server/data/field-reports";
import { trailerWorkOrdersAvailable } from "@/server/data/maintenance";
import { getUserNames } from "@/server/data/quotes";
import { businessToday } from "@/server/data/settings";

export const metadata = { title: "Driver report" };

const tone = { open: "amber", acknowledged: "blue", resolved: "green" } as const;

export default async function FieldReportPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ back?: string }> }) {
  const { back } = await searchParams;
  const access = await requirePagePermission("field_reports.view");
  const { id } = await params;
  const r = await getFieldReport(id);
  // A trailer report becomes a trailer work order once trailer work orders are installed (20261115000100).
  const trailerWorkOrders = Boolean(r?.trailer_id && r.equipment !== "truck" && can(access, "maintenance.manage") && (await trailerWorkOrdersAvailable()));
  if (!r) notFound();
  const [people, { timezone }] = await Promise.all([getUserNames(), businessToday()]);
  const who = (u: string | null) => people[u ?? ""] ?? "Someone";
  const unit = r.equipment === "truck" ? r.snapshot.truck_unit : r.equipment === "trailer" ? r.snapshot.trailer_unit : null;
  return (
    <>
      <ReturnLink back={back} />
      <PageHeader
        crumbs={[{ label: "Driver Reports", href: "/field-reports" }, { label: REPORT_KIND_LABELS[r.kind] }]}
        title={`${REPORT_KIND_LABELS[r.kind]} — ${r.snapshot.driver_name}`}
        description={`${r.snapshot.order_number} load ${r.snapshot.load_number} · ${formatDate(r.snapshot.load_date)}${r.snapshot.customer_name ? ` · ${r.snapshot.customer_name}` : ""}`}
        badges={<Badge tone={tone[r.status]}>{r.status}</Badge>}
        actions={can(access, "field_reports.manage") ? <ReportActions reportId={r.id} status={r.status} /> : undefined}
      />
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <Card>
          <CardHeader title="What the driver reported" description={`Sent ${formatDateTime(r.created_at, timezone)}`} />
          <CardBody>
            <p className="text-lg whitespace-pre-line">{r.description}</p>
          </CardBody>
          <CardBody className="border-t border-line">
            <DescriptionList items={[
              { label: "Equipment", value: unit ? `${r.equipment} ${unit}` : `Truck ${r.snapshot.truck_unit ?? "—"}${r.snapshot.trailer_unit ? ` · trailer ${r.snapshot.trailer_unit}` : ""}` },
              { label: "Acknowledged", value: r.acknowledged_at ? `${who(r.acknowledged_by)}, ${formatDateTime(r.acknowledged_at, timezone)}${r.acknowledge_note ? ` — ${r.acknowledge_note}` : ""}` : "Not yet" },
              { label: "Resolved", value: r.resolved_at ? `${who(r.resolved_by)}, ${formatDateTime(r.resolved_at, timezone)} — ${r.resolution_note}` : "Not yet" },
            ]} />
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Act on it" description="The report does not change anything by itself." />
          <CardBody className="flex flex-col gap-2">
            {can(access, "dispatch.view") && <ButtonLink href={`/dispatch?date=${r.snapshot.load_date}&load=${r.load_id}`} variant="secondary" icon={<CalendarRange className="size-4" />}>Open the load on dispatch</ButtonLink>}
            {can(access, "orders.view") && <ButtonLink href={`/orders/${r.order_id}`} variant="secondary" icon={<ClipboardList className="size-4" />}>Open the order</ButtonLink>}
            {can(access, "fleet.view") && r.truck_id && r.equipment !== "trailer" && <ButtonLink href={`/fleet/trucks/${r.truck_id}`} variant="secondary" icon={<Truck className="size-4" />}>Truck record and service status</ButtonLink>}
            {can(access, "maintenance.manage") && r.truck_id && r.equipment !== "trailer" && <ButtonLink href={`/maintenance/work-orders/new?truck=${r.truck_id}&report=${r.id}&driver=${r.driver_id}`} variant="secondary" icon={<Wrench className="size-4" />}>Create a work order</ButtonLink>}
            {trailerWorkOrders && <ButtonLink href={`/maintenance/work-orders/new?trailer=${r.trailer_id}&report=${r.id}&driver=${r.driver_id}`} variant="secondary" icon={<Wrench className="size-4" />}>Create a work order</ButtonLink>}
            {can(access, "fleet.view") && r.trailer_id && r.equipment !== "truck" && <ButtonLink href={`/fleet/trailers/${r.trailer_id}`} variant="secondary" icon={<Truck className="size-4" />}>Trailer record and service status</ButtonLink>}
          </CardBody>
        </Card>
      </div>
    </>
  );
}
