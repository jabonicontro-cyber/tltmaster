import { notFound, redirect } from "next/navigation";
import { WorkOrderForm } from "@/components/maintenance/work-order-form";
import { Card, CardBody } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { requirePagePermission } from "@/server/auth";
import { getWorkOrder, listAssignees, listDriverOptions } from "@/server/data/maintenance";
import { updateWorkOrder } from "../../../actions";

export const metadata = { title: "Edit work order" };

const s = (n: number | null) => (n === null ? "" : String(n));

export default async function EditWorkOrderPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePagePermission("maintenance.manage");
  const { id } = await params;
  const detail = await getWorkOrder(id, { costs: false });
  if (!detail) notFound();
  const { wo, truck } = detail;
  if (wo.status === "closed" || wo.status === "canceled") redirect(`/maintenance/work-orders/${id}`);
  const [drivers, assignees] = await Promise.all([listDriverOptions(), listAssignees()]);
  return (
    <>
      <PageHeader
        crumbs={[{ label: "Maintenance", href: "/maintenance" }, { label: wo.number, href: `/maintenance/work-orders/${id}` }, { label: "Edit" }]}
        title={`Edit ${wo.number}`}
        description={`Truck ${truck?.unit_number ?? "—"}`}
      />
      <Card>
        <CardBody>
          <WorkOrderForm
            mode="edit"
            action={updateWorkOrder.bind(null, id)}
            cancelHref={`/maintenance/work-orders/${id}`}
            options={{ trucks: [], drivers, assignees }}
            initial={{
              truck_id: wo.truck_id, title: wo.title, description: wo.description, category: wo.category, urgency: wo.urgency,
              safety_critical: wo.safety_critical, driver_id: wo.driver_id ?? "", assigned_to: wo.assigned_to ?? "",
              scheduled_for: wo.scheduled_for ?? "", due_on: wo.due_on ?? "", field_report_id: "",
              findings: wo.findings, labor_hours: s(wo.labor_hours), odometer_at_service: s(wo.odometer_at_service),
              engine_hours_at_service: s(wo.engine_hours_at_service), edit_seq: wo.edit_seq,
            }}
          />
        </CardBody>
      </Card>
    </>
  );
}
