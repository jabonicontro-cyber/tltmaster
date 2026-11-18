import { notFound, redirect } from "next/navigation";
import { WorkOrderForm } from "@/components/maintenance/work-order-form";
import { Card, CardBody } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { requirePagePermission } from "@/server/auth";
import { getWorkOrder, listAssignees, listDriverOptions } from "@/server/data/maintenance";
import { createClient } from "@/server/supabase/server";
import { partWaits } from "@/server/data/parts";
import { updateWorkOrder } from "../../../actions";

export const metadata = { title: "Edit work order" };

const s = (n: number | null) => (n === null ? "" : String(n));

export default async function EditWorkOrderPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePagePermission("maintenance.manage");
  const { id } = await params;
  const detail = await getWorkOrder(id, { costs: false });
  if (!detail) notFound();
  const { wo, truck, trailer } = detail;
  if (wo.status === "closed" || wo.status === "canceled") redirect(`/maintenance/work-orders/${id}`);
  const supabase = await createClient();
  const [drivers, assignees, logged, onOrder] = await Promise.all([
    listDriverOptions(), listAssignees(),
    // Logged time (20261120002900) makes labor hours computed; before the migration the query fails and labor stays typed.
    supabase.from("work_order_time_entries").select("id", { count: "exact", head: true }).eq("work_order_id", id),
    // Parts still on order (WK3): a scheduled date before the last one is expected gets a warning in the form.
    partWaits(id).catch(() => ({ installed: false, rows: [] })),
  ]);
  const dated = onOrder.rows.filter((p) => p.status === "waiting" && p.expected_on).sort((a, b) => (b.expected_on ?? "").localeCompare(a.expected_on ?? ""));
  const partsExpected = dated.length ? { on: dated[0].expected_on!, part: dated[0].description } : null;
  return (
    <>
      <PageHeader
        crumbs={[{ label: "Maintenance", href: "/maintenance" }, { label: wo.number, href: `/maintenance/work-orders/${id}` }, { label: "Edit" }]}
        title={`Edit ${wo.number}`}
        description={trailer ? `Trailer ${trailer.unit_number}` : `Truck ${truck?.unit_number ?? "–"}`}
      />
      <Card>
        <CardBody>
          <WorkOrderForm
            mode="edit"
            laborFromTime={!logged.error && (logged.count ?? 0) > 0}
            partsExpected={partsExpected}
            action={updateWorkOrder.bind(null, id)}
            cancelHref={`/maintenance/work-orders/${id}`}
            options={{ trucks: [], drivers, assignees }}
            initial={{
              truck_id: wo.truck_id ?? "", trailer_id: wo.trailer_id ?? "", title: wo.title, description: wo.description, category: wo.category, urgency: wo.urgency,
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
