import { WorkOrderForm } from "@/components/maintenance/work-order-form";
import { Card, CardBody } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { Notice } from "@/components/ui/states";
import { requirePagePermission } from "@/server/auth";
import { listAssignees, listDriverOptions, listTrucks } from "@/server/data/maintenance";
import { createWorkOrder } from "../../actions";

export const metadata = { title: "New work order" };

type Search = { truck?: string; report?: string; driver?: string };

const uuidLike = (v?: string) => (v && /^[0-9a-f-]{36}$/i.test(v) ? v : "");

export default async function NewWorkOrderPage({ searchParams }: { searchParams: Promise<Search> }) {
  await requirePagePermission("maintenance.manage");
  const sp = await searchParams;
  const [trucks, drivers, assignees] = await Promise.all([listTrucks(), listDriverOptions(), listAssignees()]);
  const active = trucks.filter((t) => t.active);
  return (
    <>
      <PageHeader crumbs={[{ label: "Maintenance", href: "/maintenance" }, { label: "Work orders", href: "/maintenance/work-orders" }, { label: "New" }]} title="New work order" />
      {active.length === 0 ? (
        <Notice tone="warning" title="No trucks">Add trucks in Fleet first; a work order belongs to a truck.</Notice>
      ) : (
        <Card>
          <CardBody>
            <WorkOrderForm
              mode="create"
              action={createWorkOrder}
              cancelHref="/maintenance/work-orders"
              options={{
                trucks: active.map((t) => ({ id: t.id, unit_number: t.unit_number, out_of_service: t.service_status === "out_of_service" })),
                drivers,
                assignees,
              }}
              initial={{
                truck_id: uuidLike(sp.truck), title: "", description: "", category: "repair", urgency: "normal", safety_critical: false,
                driver_id: uuidLike(sp.driver), assigned_to: "", scheduled_for: "", due_on: "", field_report_id: uuidLike(sp.report),
              }}
            />
          </CardBody>
        </Card>
      )}
    </>
  );
}
