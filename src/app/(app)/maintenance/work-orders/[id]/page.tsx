import { CopyReference } from "@/components/ui/copy-reference";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Pencil } from "lucide-react";
import { fmtMoney, fmtNum, SafetyBadge, UrgencyBadge, WoStatusBadge } from "@/components/maintenance/bits";
import { ClearanceActions, CostForm, RemoveCostButton, StatusActions } from "@/components/maintenance/work-order-actions";
import { CrewPanel, TaskChecklist } from "@/components/maintenance/crew-panel";
import { EstimateForm } from "@/components/maintenance/shop-forms";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { DescriptionList } from "@/components/ui/description-list";
import { PageHeader } from "@/components/ui/page-header";
import { Notice } from "@/components/ui/states";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { formatDate, formatDateTime } from "@/lib/dates";
import { CLEARANCE_STATUSES, COST_KINDS, WO_CATEGORIES, WO_STATUSES } from "@/lib/maintenance";
import { can } from "@/lib/permissions";
import { requirePagePermission } from "@/server/auth";
import { getWorkOrder } from "@/server/data/maintenance";
import { getWorkOrderCrew } from "@/server/data/maintenance-crew";
import { getUserNames } from "@/server/data/quotes";
import { businessToday } from "@/server/data/settings";

export const metadata = { title: "Work order" };

const EVENT_LABELS: Record<string, string> = {
  created: "Created", updated: "Details edited", status: "Status changed", assigned: "Mechanic assigned",
  scheduled: "Scheduled", rescheduled: "Rescheduled", unscheduled: "Schedule removed", canceled: "Canceled",
  inspection_started: "Inspection started", inspection_failed: "Inspection failed", cleared: "Cleared for service",
  restricted: "Unit restricted", returned_to_service: "Unit returned to service",
  crew: "Crew", time: "Labor time", task: "Checklist",
};

export default async function WorkOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const access = await requirePagePermission("maintenance.view");
  const { id } = await params;
  const canCosts = can(access, "maintenance.costs");
  const detail = await getWorkOrder(id, { costs: canCosts });
  if (!detail) notFound();
  const { wo, events, costs, truck, trailer, driver, schedule } = detail;
  // A work order belongs to one truck or one trailer.
  const unit = trailer ?? truck;
  const unitWord = trailer ? "Trailer" : "Truck";
  const unitHref = trailer ? `/fleet/trailers/${trailer.id}` : truck ? `/fleet/trucks/${truck.id}` : null;
  const [people, { timezone, today }, crew] = await Promise.all([getUserNames(), businessToday(), getWorkOrderCrew(id, access.userId)]);
  const who = (u: string | null) => (u ? people[u] ?? "Former member" : "—");
  const manage = can(access, "maintenance.manage");
  const canClear = can(access, "maintenance.clear");
  const editable = manage && !["closed", "canceled"].includes(wo.status);
  const total = (costs ?? []).reduce((s, c) => s + Math.round(c.quantity * c.unit_cost_cents), 0);

  return (
    <>
      <PageHeader
        crumbs={[{ label: "Maintenance", href: "/maintenance" }, { label: "Work orders", href: "/maintenance/work-orders" }, { label: wo.number }]}
        title={`${wo.number} · ${wo.title}`}
        description={`${unitWord} ${unit?.unit_number ?? "—"} · ${WO_CATEGORIES[wo.category]}${driver ? ` · Driver ${driver.name}` : ""}`}
        badges={<>
          <WoStatusBadge status={wo.status} />
          <CopyReference value={wo.number} label="work order number" />
          <UrgencyBadge urgency={wo.urgency} />
          {wo.safety_critical && <SafetyBadge />}
          {wo.clearance_status && <Badge tone={wo.clearance_status === "cleared" ? "green" : wo.clearance_status === "failed" ? "red" : "amber"}>{CLEARANCE_STATUSES[wo.clearance_status]}</Badge>}
        </>}
        actions={editable && <ButtonLink href={`/maintenance/work-orders/${wo.id}/edit`} variant="secondary" icon={<Pencil className="size-4" />}>Edit</ButtonLink>}
      />

      {wo.safety_critical && !["completed", "closed", "canceled"].includes(wo.status) && (
        <div className="mb-5">
          <Notice tone="warning" title={`${unitWord} restricted`}>
            {unitWord} {unit?.unit_number} is out of service and cannot be dispatched until someone authorized records a passed inspection.
          </Notice>
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="space-y-5">
          {manage && wo.status !== "closed" && wo.status !== "canceled" && (
            <Card>
              <CardHeader title="Next step" />
              <CardBody><StatusActions id={wo.id} status={wo.status} safetyCritical={wo.safety_critical} editSeq={wo.edit_seq} canClear={canClear} unit={trailer ? "trailer" : "truck"} /></CardBody>
            </Card>
          )}
          {wo.status === "awaiting_inspection" && (
            <Card>
              <CardHeader title="Inspection and clearance" description={wo.clearance_status === "in_progress" ? `Inspection started by ${who(wo.inspector_id)}.` : "The repair is done and waits for an inspector."} />
              <CardBody>
                {canClear
                  ? <ClearanceActions id={wo.id} clearance={wo.clearance_status === "in_progress" ? "in_progress" : "awaiting"} unit={trailer ? "trailer" : "truck"} />
                  : <p className="text-sm text-muted">Only people allowed to clear vehicles for service (Maintenance → clear) can record the inspection.</p>}
              </CardBody>
            </Card>
          )}

          {crew.installed && (
            <div className="grid gap-5 xl:grid-cols-2">
              <Card>
                <CardHeader title="Crew and labor" description="Who is working on it and the time they logged. Labor hours come from this time." />
                <CardBody className="space-y-4">
                  {"estimated_hours" in wo && (manage && editable
                    ? <EstimateForm workOrderId={wo.id} hours={(wo as { estimated_hours: number | null }).estimated_hours} />
                    : <p className="text-sm text-muted">Estimate: {(wo as { estimated_hours: number | null }).estimated_hours ?? "not set"}{(wo as { estimated_hours: number | null }).estimated_hours ? " h" : ""}</p>)}
                  <CrewPanel workOrderId={wo.id} status={wo.status} data={crew} me={access.userId} canManage={manage} today={today} timeZone={timezone} />
                </CardBody>
              </Card>
              <Card>
                <CardHeader title="Checklist" />
                <CardBody><TaskChecklist workOrderId={wo.id} status={wo.status} tasks={crew.tasks} canManage={manage} /></CardBody>
              </Card>
            </div>
          )}

          <Card>
            <CardHeader title="Details" />
            <CardBody>
              <DescriptionList items={[
                { label: "Description", value: wo.description || "—", wide: true },
                { label: "Findings", value: wo.findings || "—", wide: true },
                { label: crew.installed ? "Lead mechanic" : "Mechanic", value: wo.assigned_to ? who(wo.assigned_to) : "Unassigned" },
                { label: "Scheduled for", value: wo.scheduled_for ? formatDate(wo.scheduled_for) : "Not scheduled" },
                { label: "Due by", value: wo.due_on ? formatDate(wo.due_on) : "—" },
                { label: "Labor hours", value: fmtNum(wo.labor_hours, " h") },
                { label: "Odometer at service", value: fmtNum(wo.odometer_at_service, " mi") },
                { label: "Engine hours at service", value: fmtNum(wo.engine_hours_at_service, " h") },
                ...(wo.cleared_at ? [{ label: "Cleared", value: `${who(wo.cleared_by)}, ${formatDateTime(wo.cleared_at, timezone)}${wo.clearance_notes ? ` — ${wo.clearance_notes}` : ""}`, wide: true }] : []),
                ...(wo.clearance_status === "failed" ? [{ label: "Failed inspection", value: wo.clearance_notes, wide: true }] : []),
                ...(wo.status === "canceled" ? [{ label: "Cancel reason", value: wo.cancel_reason, wide: true }] : []),
              ]} />
            </CardBody>
          </Card>

          {canCosts && costs && (
            <Card>
              <CardHeader title="Parts, labor and costs" description={`Total ${fmtMoney(total)} · visible only to people with cost access.`} />
              {costs.length > 0 && (
                <TableWrap>
                  <Table>
                    <thead><tr><Th>Item</Th><Th className="hidden sm:table-cell">Vendor</Th><Th className="text-right">Qty</Th><Th className="text-right">Unit</Th><Th className="text-right">Amount</Th><Th><span className="sr-only">Remove</span></Th></tr></thead>
                    <tbody>
                      {costs.map((c) => (
                        <Tr key={c.id}>
                          <Td><div className="font-medium">{c.description}</div><div className="text-xs text-muted">{COST_KINDS[c.kind]}{c.part_number ? ` · ${c.part_number}` : ""}</div></Td>
                          <Td className="hidden text-sm sm:table-cell">{c.vendor_name || "—"}</Td>
                          <Td className="text-right tabular">{c.quantity}</Td>
                          <Td className="text-right tabular">{fmtMoney(c.unit_cost_cents)}</Td>
                          <Td className="text-right font-medium tabular">{fmtMoney(Math.round(c.quantity * c.unit_cost_cents))}</Td>
                          <Td>{!["closed", "canceled"].includes(wo.status) && <RemoveCostButton workOrderId={wo.id} costId={c.id} label={c.description} />}</Td>
                        </Tr>
                      ))}
                    </tbody>
                  </Table>
                </TableWrap>
              )}
              {!["closed", "canceled"].includes(wo.status) && <CardBody className="border-t border-line"><CostForm workOrderId={wo.id} /></CardBody>}
            </Card>
          )}

          <Card>
            <CardHeader title="History" />
            <ol className="divide-y divide-line text-sm">
              {events.map((e) => (
                <li key={e.id} className="px-4 py-2.5 sm:px-5">
                  <div className="flex flex-wrap justify-between gap-2">
                    <span className="font-medium text-ink">
                      {EVENT_LABELS[e.kind] ?? e.kind}
                      {e.kind === "status" && e.to_status ? `: ${WO_STATUSES[e.to_status as keyof typeof WO_STATUSES] ?? e.to_status}` : ""}
                      {(e.kind === "scheduled" || e.kind === "rescheduled") && typeof e.details.scheduled_for === "string" ? ` for ${formatDate(e.details.scheduled_for)}` : ""}
                    </span>
                    <span className="text-muted">{who(e.actor_id)} · {formatDateTime(e.created_at, timezone)}</span>
                  </div>
                  {e.note && <p className="mt-0.5 whitespace-pre-line text-muted">{e.note}</p>}
                </li>
              ))}
            </ol>
          </Card>
        </div>

        <div className="space-y-5">
          <Card>
            <CardHeader title={unitWord} />
            <CardBody className="space-y-2 text-sm">
              <p><strong className="text-ink">{unit?.unit_number ?? "—"}</strong> · {unit?.service_status === "out_of_service" ? <span className="font-medium text-critical">Out of service</span> : "In service"}</p>
              {unit?.out_of_service_reason && <p className="text-muted">{unit.out_of_service_reason}</p>}
              {can(access, "fleet.view") && unitHref && <Link href={unitHref} className="font-medium text-ink underline">{unitWord} record</Link>}
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Linked" />
            <CardBody className="space-y-1.5 text-sm">
              <p>Source: {wo.source === "preventive" ? "preventive schedule" : wo.source === "field_report" ? "driver report" : "entered by the shop"}</p>
              {schedule && <p>Schedule: <Link href="/maintenance/preventive" className="underline">{schedule.name}</Link></p>}
              {wo.field_report_id && can(access, "field_reports.view") && <p><Link href={`/field-reports/${wo.field_report_id}`} className="underline">Driver report</Link></p>}
              <p className="text-muted">Created by {who(wo.created_by)} · {formatDateTime(wo.created_at, timezone)}</p>
            </CardBody>
          </Card>
        </div>
      </div>
    </>
  );
}
