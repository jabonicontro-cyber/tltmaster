import { WorkOrderForm } from "@/components/maintenance/work-order-form";
import { Card, CardBody } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { Notice } from "@/components/ui/states";
import { REPORT_KIND_LABELS } from "@/lib/driver/rules";
import { workOrderFromReport } from "@/lib/maintenance-triage";
import { can } from "@/lib/permissions";
import { requirePagePermission } from "@/server/auth";
import { getFieldReport } from "@/server/data/field-reports";
import { listAssignees, listDriverOptions, listTrailers, listTrucks, trailerWorkOrdersAvailable } from "@/server/data/maintenance";
import { createWorkOrder } from "../../actions";

export const metadata = { title: "New work order" };

type Search = { truck?: string; trailer?: string; report?: string; driver?: string };

const uuidLike = (v?: string) => (v && /^[0-9a-f-]{36}$/i.test(v) ? v : "");

export default async function NewWorkOrderPage({ searchParams }: { searchParams: Promise<Search> }) {
  const access = await requirePagePermission("maintenance.manage");
  const sp = await searchParams;
  const reportId = uuidLike(sp.report);
  const [trucks, drivers, assignees, trailersOk, report] = await Promise.all([listTrucks(), listDriverOptions(), listAssignees(), trailerWorkOrdersAvailable(),
    // From a driver report: its words become the title and description, and its kind and words suggest the rest.
    reportId && can(access, "field_reports.view") ? getFieldReport(reportId).catch(() => null) : Promise.resolve(null)]);
  const draft = report ? workOrderFromReport(report, REPORT_KIND_LABELS[report.kind] ?? "Driver report") : null;
  const active = trucks.filter((t) => t.active);
  // Trailers are offered only once trailer work orders are installed (migration 20261115000100).
  const trailers = trailersOk ? (await listTrailers()).filter((t) => t.active) : null;
  return (
    <>
      <PageHeader crumbs={[{ label: "Maintenance", href: "/maintenance" }, { label: "Work orders", href: "/maintenance/work-orders" }, { label: "New" }]} title="New work order" />
      {active.length === 0 && !trailers?.length ? (
        <Notice tone="warning" title="No trucks or trailers">Add trucks or trailers in Fleet first; a work order belongs to one of them.</Notice>
      ) : (
        <Card>
          <CardBody>
            <WorkOrderForm
              mode="create"
              action={createWorkOrder}
              cancelHref="/maintenance/work-orders"
              options={{
                trucks: active.map((t) => ({ id: t.id, unit_number: t.unit_number, out_of_service: t.service_status === "out_of_service" })),
                trailers: trailers?.map((t) => ({ id: t.id, unit_number: t.unit_number, out_of_service: t.service_status === "out_of_service", default_truck_id: t.default_truck_id })) ?? null,
                drivers,
                assignees,
              }}
              initial={{
                truck_id: uuidLike(sp.truck), trailer_id: trailers ? uuidLike(sp.trailer) : "",
                title: draft?.title ?? "", description: draft?.description ?? "", category: draft?.category ?? "repair", urgency: draft?.urgency ?? "normal", safety_critical: draft?.safety_critical ?? false,
                driver_id: uuidLike(sp.driver), assigned_to: "", scheduled_for: "", due_on: "", field_report_id: reportId,
              }}
              suggestion={draft ? { from: "the driver's report", reasons: draft.reasons } : null}
            />
          </CardBody>
        </Card>
      )}
    </>
  );
}
