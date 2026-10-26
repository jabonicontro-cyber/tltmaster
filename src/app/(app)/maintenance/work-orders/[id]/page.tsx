import { CopyReference } from "@/components/ui/copy-reference";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Pencil } from "lucide-react";
import { fmtMoney, fmtNum, SafetyBadge, UrgencyBadge, WoStatusBadge } from "@/components/maintenance/bits";
import { ClearanceActions, CostForm, RemoveCostButton, StatusActions } from "@/components/maintenance/work-order-actions";
import { CrewPanel, TaskChecklist } from "@/components/maintenance/crew-panel";
import { EstimateForm } from "@/components/maintenance/shop-forms";
import { TriageCard } from "@/components/maintenance/triage-card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/cn";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { Notice } from "@/components/ui/states";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { formatDate, formatDateTime } from "@/lib/dates";
import { CLEARANCE_STATUSES, COST_KINDS, WO_CATEGORIES, WO_STATUSES } from "@/lib/maintenance";
import { can } from "@/lib/permissions";
import { requirePagePermission } from "@/server/auth";
import { getWorkOrder } from "@/server/data/maintenance";
import { completedJobs } from "@/server/data/maintenance-estimates";
import { learnedEstimate, type LearnedEstimate } from "@/lib/maintenance-estimate";
import { getLatestTriage, getWorkOrderCrew } from "@/server/data/maintenance-crew";
import { facesForUsers } from "@/server/data/faces";
import { getUserNames } from "@/server/data/quotes";
import { businessToday } from "@/server/data/settings";

export const metadata = { title: "Work order" };

const EVENT_LABELS: Record<string, string> = {
  created: "Created", updated: "Details edited", status: "Status changed", assigned: "Mechanic assigned",
  scheduled: "Scheduled", rescheduled: "Rescheduled", unscheduled: "Schedule removed", canceled: "Canceled",
  inspection_started: "Inspection started", inspection_failed: "Inspection failed", cleared: "Cleared for service",
  restricted: "Unit restricted", returned_to_service: "Unit returned to service",
  crew: "Crew", time: "Labor time", task: "Checklist", triage: "Triage",
};

type Tab = "tasks" | "labor" | "costs" | "triage" | "activity";

export default async function WorkOrderPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string }> }) {
  const access = await requirePagePermission("maintenance.view");
  const { id } = await params;
  const sp = await searchParams;
  const canCosts = can(access, "maintenance.costs");
  const detail = await getWorkOrder(id, { costs: canCosts });
  if (!detail) notFound();
  const { wo, events, costs, truck, trailer, driver, schedule } = detail;
  // A work order belongs to one truck or one trailer.
  const unit = trailer ?? truck;
  const unitWord = trailer ? "Trailer" : "Truck";
  const unitHref = trailer ? `/fleet/trailers/${trailer.id}` : truck ? `/fleet/trucks/${truck.id}` : null;
  const [people, { timezone, today }, crew, triage, history] = await Promise.all([getUserNames(), businessToday(), getWorkOrderCrew(id, access.userId), getLatestTriage(id), completedJobs().catch(() => ({ installed: false, jobs: [] }))]);
  // B91: what comparable completed jobs took, from the company's own recorded labor. Shown beside the shop's estimate,
  // never written over it.
  const equipment = trailer ? (trailer as { trailer_type?: string }).trailer_type ?? null : truck ? (truck as { truck_type?: string }).truck_type ?? null : null;
  const learned = learnedEstimate({ id: wo.id, category: wo.category, equipment, title: wo.title }, history.jobs);
  const who = (u: string | null) => (u ? people[u] ?? "Former member" : "—");
  const manage = can(access, "maintenance.manage");
  const canClear = can(access, "maintenance.clear");
  const editable = manage && !["closed", "canceled"].includes(wo.status);
  const total = (costs ?? []).reduce((s, c) => s + Math.round(c.quantity * c.unit_cost_cents), 0);
  const estimate = "estimated_hours" in wo ? (wo as { estimated_hours: number | null }).estimated_hours : null;
  const doneTasks = crew.tasks.filter((t) => t.status === "done").length;
  const showTriage = triage.installed && Boolean(triage.triage || ["reported", "triaged"].includes(wo.status));
  // The sections as tabs; the default is the one the job needs now.
  const tabs: Array<{ key: Tab; label: string; count?: number }> = [
    ...(showTriage ? [{ key: "triage" as const, label: "Triage" }] : []),
    { key: "tasks", label: "Tasks", count: crew.installed ? crew.tasks.length : undefined },
    { key: "labor", label: "Labor" },
    ...(canCosts && costs ? [{ key: "costs" as const, label: "Parts and costs", count: costs.length }] : []),
    { key: "activity", label: "Activity", count: events.length },
  ];
  const fallback: Tab = showTriage && ["reported", "triaged"].includes(wo.status) ? "triage" : wo.status === "in_progress" ? "labor" : "tasks";
  const tab: Tab = tabs.some((t) => t.key === sp.tab) ? (sp.tab as Tab) : fallback;

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

      {manage && wo.status !== "closed" && wo.status !== "canceled" && (
        <Card className="mb-5">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-3 px-5 py-4 sm:px-6">
            <span className="text-sm font-semibold text-ink">Next step</span>
            <StatusActions id={wo.id} status={wo.status} safetyCritical={wo.safety_critical} editSeq={wo.edit_seq} canClear={canClear} unit={trailer ? "trailer" : "truck"} />
          </div>
        </Card>
      )}
      {wo.status === "awaiting_inspection" && (
        <Card className="mb-5">
          <CardHeader title="Inspection and clearance" description={wo.clearance_status === "in_progress" ? `Inspection started by ${who(wo.inspector_id)}.` : "The repair is done and waits for an inspector."} />
          <CardBody>
            {canClear
              ? <ClearanceActions id={wo.id} clearance={wo.clearance_status === "in_progress" ? "in_progress" : "awaiting"} unit={trailer ? "trailer" : "truck"} />
              : <p className="text-sm text-muted">Only people allowed to clear vehicles for service (Maintenance → clear) can record the inspection.</p>}
          </CardBody>
        </Card>
      )}

      <div className="grid gap-5 lg:grid-cols-[24rem_minmax(0,1fr)]">
        {/* Left: what the job is (redesign 2026-10-26, after the owner's work order reference). */}
        <div className="space-y-5">
          <Card>
            <CardHeader title="Work order" description={wo.description || undefined} />
            <dl className="divide-y divide-line/70 border-t border-line/70 text-sm">
              {[
                ["Category", WO_CATEGORIES[wo.category]],
                ["Priority", <span key="p" className="flex flex-wrap items-center gap-1.5"><UrgencyBadge urgency={wo.urgency} />{wo.safety_critical && <SafetyBadge />}</span>],
                ["Status", <WoStatusBadge key="s" status={wo.status} />],
                ["Scheduled for", wo.scheduled_for ? formatDate(wo.scheduled_for) : "Not scheduled"],
                ["Due by", wo.due_on ? formatDate(wo.due_on) : "—"],
                ["Estimate", <EstimateValue key="e" shop={estimate} learned={learned} />],
                [unitWord, <span key="u">{unit?.unit_number ?? "—"} · {unit?.service_status === "out_of_service" ? <span className="font-medium text-critical">Out of service</span> : "In service"}{can(access, "fleet.view") && unitHref ? <> · <Link href={unitHref} className="underline">Record</Link></> : null}</span>],
                [crew.installed ? "Lead mechanic" : "Mechanic", wo.assigned_to ? who(wo.assigned_to) : "Unassigned"],
                ...(driver ? [["Driver", driver.name] as const] : []),
                ["Odometer at service", fmtNum(wo.odometer_at_service, " mi")],
                ["Engine hours at service", fmtNum(wo.engine_hours_at_service, " h")],
                ["Source", wo.source === "preventive" ? "Preventive schedule" : wo.source === "field_report" ? "Driver report" : "Entered by the shop"],
                ["Created", `${who(wo.created_by)} · ${formatDateTime(wo.created_at, timezone)}`],
              ].map(([label, value]) => (
                <div key={String(label)} className="grid grid-cols-[8rem_minmax(0,1fr)] items-center gap-3 px-5 py-2.5 sm:px-6">
                  <dt className="text-muted">{label}</dt>
                  <dd className="min-w-0 text-ink">{value}</dd>
                </div>
              ))}
            </dl>
            {(schedule || (wo.field_report_id && can(access, "field_reports.view")) || wo.findings || wo.cleared_at || wo.clearance_status === "failed" || wo.status === "canceled") && (
              <CardBody className="space-y-2 border-t border-line/70 text-sm">
                {wo.findings && <p><span className="text-muted">Findings: </span>{wo.findings}</p>}
                {schedule && <p><span className="text-muted">Schedule: </span><Link href="/maintenance/preventive" className="underline">{schedule.name}</Link></p>}
                {wo.field_report_id && can(access, "field_reports.view") && <p><Link href={`/field-reports/${wo.field_report_id}`} className="underline">Driver report</Link></p>}
                {wo.cleared_at && <p><span className="text-muted">Cleared: </span>{who(wo.cleared_by)}, {formatDateTime(wo.cleared_at, timezone)}{wo.clearance_notes ? ` — ${wo.clearance_notes}` : ""}</p>}
                {wo.clearance_status === "failed" && <p><span className="text-muted">Failed inspection: </span>{wo.clearance_notes}</p>}
                {wo.status === "canceled" && <p><span className="text-muted">Cancel reason: </span>{wo.cancel_reason}</p>}
              </CardBody>
            )}
            <dl className="grid grid-cols-4 border-t border-line/70 text-center" aria-label="Work order totals">
              {[
                ["Tasks", crew.installed ? `${doneTasks}/${crew.tasks.length}` : "—"],
                ["Parts", canCosts && costs ? String(costs.filter((c) => c.kind === "part").length) : "—"],
                ["Time", crew.installed ? `${Math.floor(crew.totalMinutes / 60)}:${String(crew.totalMinutes % 60).padStart(2, "0")}` : fmtNum(wo.labor_hours, " h")],
                ["Total cost", canCosts && costs ? fmtMoney(total) : "—"],
              ].map(([label, value]) => (
                <div key={label} className="border-line/70 px-2 py-3 [&:not(:first-child)]:border-l">
                  <dt className="text-xs text-muted">{label}</dt>
                  <dd className="mt-0.5 text-sm font-semibold tabular text-ink">{value}</dd>
                </div>
              ))}
            </dl>
          </Card>
        </div>

        {/* Right: the work, by tab. */}
        <Card className="min-w-0">
          <nav aria-label="Work order sections" className="flex gap-1 overflow-x-auto border-b border-line/70 px-3 pt-3 sm:px-4">
            {tabs.map((t) => (
              <Link key={t.key} href={`/maintenance/work-orders/${wo.id}?tab=${t.key}`} aria-current={tab === t.key ? "page" : undefined} scroll={false}
                className={cn("-mb-px flex h-10 shrink-0 items-center gap-1.5 border-b-2 px-3 text-sm font-semibold", tab === t.key ? "border-strong text-ink" : "border-transparent text-muted hover:text-ink")}>
                <span className="pill-text">{t.label}</span>
                {t.count !== undefined && <Badge tone="gray">{t.count}</Badge>}
              </Link>
            ))}
          </nav>
          <div className="p-5 sm:p-6">
            {tab === "tasks" && (crew.installed ? <TaskChecklist workOrderId={wo.id} status={wo.status} tasks={crew.tasks} canManage={manage} /> : <p className="text-sm text-muted">Checklists need a database update that has not been installed yet.</p>)}
            {tab === "labor" && (crew.installed ? (
              <div className="space-y-4">
                {learned && <LearnedNote learned={learned} />}
                {"estimated_hours" in wo && (manage && editable
                  ? <EstimateForm workOrderId={wo.id} hours={estimate} />
                  : <p className="text-sm text-muted">Estimate: {estimate ?? "not set"}{estimate ? " h" : ""}</p>)}
                <CrewPanel workOrderId={wo.id} status={wo.status} data={crew} faces={await facesForUsers(crew.crew.map((c) => c.userId))} me={access.userId} canManage={manage} today={today} timeZone={timezone} />
              </div>
            ) : <p className="text-sm text-muted">Labor hours: {fmtNum(wo.labor_hours, " h")}</p>)}
            {tab === "costs" && canCosts && costs && (
              <div className="space-y-4">
                <p className="text-sm text-muted">Total {fmtMoney(total)} · visible only to people with cost access.</p>
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
                {!["closed", "canceled"].includes(wo.status) && <div className="border-t border-line/70 pt-4"><CostForm workOrderId={wo.id} /></div>}
              </div>
            )}
            {tab === "triage" && showTriage && (
              <div className="space-y-3">
                <p className="text-sm text-muted">What was reported, what is still unknown, and a suggestion. Nothing changes until someone accepts it.</p>
                <TriageCard workOrderId={wo.id} triage={triage.triage} canManage={manage} open={editable} decidedByName={triage.triage?.decidedBy ? who(triage.triage.decidedBy) : null} />
              </div>
            )}
            {tab === "activity" && (
              <ol className="relative space-y-4 border-l border-line pl-5 text-sm" aria-label="History">
                {events.map((e) => (
                  <li key={e.id} className="relative">
                    <span className="absolute top-1.5 -left-[25px] size-2.5 rounded-full border-2 border-card bg-strong" aria-hidden />
                    <p className="font-medium text-ink">
                      {EVENT_LABELS[e.kind] ?? e.kind}
                      {e.kind === "status" && e.to_status ? `: ${WO_STATUSES[e.to_status as keyof typeof WO_STATUSES] ?? e.to_status}` : ""}
                      {(e.kind === "scheduled" || e.kind === "rescheduled") && typeof e.details.scheduled_for === "string" ? ` for ${formatDate(e.details.scheduled_for)}` : ""}
                    </p>
                    {e.note && <p className="mt-0.5 whitespace-pre-line text-muted">{e.note}</p>}
                    <p className="mt-0.5 text-xs text-muted">{who(e.actor_id)} · {formatDateTime(e.created_at, timezone)}</p>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </Card>
      </div>
    </>
  );
}

function EstimateValue({ shop, learned }: { shop: number | null; learned: LearnedEstimate | null }) {
  return (
    <div className="space-y-0.5">
      <p>{shop !== null ? `${trimHours(shop)} h` : "Not set"}{shop !== null && <span className="text-muted"> · shop</span>}</p>
      {learned && <p className="text-xs text-muted">Learned: {trimHours(learned.hours)} h from {learned.jobs} completed job{learned.jobs === 1 ? "" : "s"}</p>}
    </div>
  );
}

/** Where the learned estimate comes from, in plain words (B91). */
function LearnedNote({ learned }: { learned: LearnedEstimate }) {
  return (
    <div className="rounded-2xl bg-surface px-4 py-3 text-sm">
      <p className="font-semibold text-ink">Learned estimate: {trimHours(learned.hours)} h <span className="font-normal text-muted">(usually {trimHours(learned.low)}–{trimHours(learned.high)} h)</span></p>
      <p className="mt-0.5 text-xs text-muted">
        From the labor recorded on {learned.jobs} completed {learned.match === "same job" ? "jobs like this one" : learned.match === "same category and equipment" ? "jobs of this category on the same kind of equipment" : "jobs of this category"}
        {learned.outliers ? `; ${learned.outliers} unusual job${learned.outliers === 1 ? "" : "s"} left out` : ""}. It updates as jobs are finished and never replaces the shop&apos;s own estimate.
      </p>
    </div>
  );
}

function trimHours(n: number) {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}
