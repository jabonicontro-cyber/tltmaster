import Link from "next/link";
import { CalendarClock, FileText, Gauge, Wrench } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { DescriptionList } from "@/components/ui/description-list";
import { formatDate, formatDateTime } from "@/lib/dates";
import { DOCUMENT_KINDS, documentAttention, documentState, type Availability, type DocumentKind } from "@/lib/fleet/availability";
import type { VehicleDocumentRow, VehicleRecords } from "@/server/data/fleet";
import { AvailabilityBadge, DocumentStateBadge } from "./fleet-status";
import { AssignDriverForm, DocumentForm, DocumentRowActions, OwnershipForm } from "./vehicle-panels";

const money = (cents: number) => (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
const num = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 1 });

function Unavailable({ what }: { what: string }) {
  return <p className="text-sm text-muted">{what} is not available yet: the database update that adds it has not been installed, or your role cannot see it.</p>;
}

export function AvailabilityCard({ a, timezone }: { a: Availability; timezone: string }) {
  return (
    <Card>
      <CardHeader title="Availability" description="Mechanical availability only. Driver availability and hours of service are separate." />
      <CardBody className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <AvailabilityBadge a={a} />
          <span className="text-sm">{a.ready ? "Can be dispatched now." : "Not dispatch-ready."}</span>
        </div>
        <p className="text-sm text-muted">{a.detail}</p>
        {a.upcoming.length > 0 && (
          <div>
            <p className="text-sm font-semibold">Upcoming shop visits</p>
            <ul className="mt-1 space-y-1 text-sm">
              {a.upcoming.map((u) => (
                <li key={u.number} className="flex items-center gap-2"><CalendarClock className="size-4 text-muted" aria-hidden />{formatDate(u.date)} · {u.number} · {u.title}</li>
              ))}
            </ul>
            <p className="mt-1 text-xs text-muted">Smart Dispatch does not yet check future shop dates — plan loads around them.</p>
          </div>
        )}
        <span className="sr-only">{timezone}</span>
      </CardBody>
    </Card>
  );
}

export function AssignmentCard({ truckId, current, drivers, history, names, canAssign, restricted, timezone, who }: {
  truckId: string;
  current: { id: string; name: string } | null;
  drivers: Array<{ id: string; name: string; truck: string | null }>;
  history: VehicleRecords["assignments"];
  names: Map<string, string>;
  canAssign: boolean;
  restricted: boolean;
  timezone: string;
  who: (id: string | null) => string;
}) {
  return (
    <Card>
      <CardHeader title="Driver" description="The driver who normally uses this truck (their primary truck). It does not mean the truck is in service." />
      <CardBody className="space-y-4">
        <p>{current ? <><span className="text-muted">Current: </span><Link href={`/fleet/drivers/${current.id}`} className="font-semibold hover:underline">{current.name}</Link></> : <span className="text-muted">No driver assigned.</span>}</p>
        {canAssign && <AssignDriverForm truckId={truckId} current={current} drivers={drivers} restricted={restricted} />}
        <div>
          <p className="text-sm font-semibold">Assignment history</p>
          {!history.available ? <Unavailable what="Assignment history" /> : history.rows.length === 0 ? (
            <p className="text-sm text-muted">No changes recorded yet. History starts when the database update is installed.</p>
          ) : (
            <ul className="mt-1 space-y-1 text-sm">
              {history.rows.map((h) => (
                <li key={h.id}>
                  <span className="font-medium">{names.get(h.driver_id) ?? "Driver"}</span> {h.action === "assigned" ? "assigned" : "removed"}
                  <span className="text-muted"> · {formatDateTime(h.created_at, timezone)} · {who(h.actor_id)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardBody>
    </Card>
  );
}

export function DocumentsCard({ vehicle, docs, today, canEdit, timezone, rules = null }: {
  vehicle: { kind: "truck" | "trailer"; id: string };
  docs: { available: boolean; rows: VehicleDocumentRow[] };
  /** The company's dispatch rule per checked kind (20261112000200); null when not installed. */
  rules?: Record<string, "block" | "warn"> | null;
  today: string;
  canEdit: boolean;
  timezone: string;
}) {
  const current = docs.rows.filter((d) => !d.archived_at);
  const archived = docs.rows.filter((d) => d.archived_at);
  const att = documentAttention(current, today);
  return (
    <Card>
      <CardHeader
        title="Documents"
        description="Registration, insurance, inspection certificates, permits and ownership papers — the details and dates. File upload is not available yet."
      />
      <CardBody className="space-y-4">
        {!docs.available ? <Unavailable what="Document tracking" /> : (
          <>
            {(att.expired.length > 0 || att.notRecorded.length > 0) && (
              <ul className="space-y-1 text-sm">
                {att.expired.map((d) => {
                  const rule = rules?.[d.kind];
                  const verified = Boolean(current.find((c) => c.id === d.id)?.verified_at);
                  return (
                    <li key={d.id} className="font-medium text-critical">
                      {DOCUMENT_KINDS[d.kind as DocumentKind]} expired {formatDate(d.expires_on)}.
                      {rule && <span className="font-normal text-ink"> {rule === "block" && verified ? "Blocks dispatch until the renewed document is recorded." : rule === "block" ? "Blocks dispatch once verified — confirm whether it was renewed." : "Dispatch is warned (company rule)."}</span>}
                    </li>
                  );
                })}
                {att.notRecorded.map((k) => <li key={k} className="text-muted">{DOCUMENT_KINDS[k]} not recorded.</li>)}
              </ul>
            )}
            {current.length === 0 ? <p className="text-sm text-muted">No documents recorded.</p> : (
              <ul className="divide-y divide-line">
                {current.map((d) => (
                  <li key={d.id} className="py-2.5">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="flex flex-wrap items-center gap-2 font-semibold">
                          <FileText className="size-4 text-muted" aria-hidden />
                          {d.kind === "other" ? d.title : DOCUMENT_KINDS[d.kind]}{d.kind !== "other" && d.title ? ` · ${d.title}` : ""}
                          <DocumentStateBadge state={documentState(d.expires_on, today)} expiresOn={d.expires_on} />
                          {rules && d.kind in rules && <Badge tone={d.verified_at ? "green" : "gray"}>{d.verified_at ? "Verified" : "Not verified"}</Badge>}
                        </p>
                        <p className="text-sm text-muted">
                          {[d.reference_number && `No. ${d.reference_number}`, d.issuing_authority, d.issued_on && `issued ${formatDate(d.issued_on)}`].filter(Boolean).join(" · ") || "No number or issuer recorded"}
                        </p>
                        {d.notes && <p className="text-sm whitespace-pre-line">{d.notes}</p>}
                      </div>
                      {canEdit && <DocumentRowActions vehicle={vehicle} doc={d} canVerify={Boolean(rules && d.kind in rules && !d.verified_at)} />}
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {canEdit && (
              <details className="rounded-xl border border-line px-3 py-2">
                <summary className="cursor-pointer text-sm font-semibold">Add a document</summary>
                <div className="mt-3"><DocumentForm vehicle={vehicle} /></div>
              </details>
            )}
            {archived.length > 0 && (
              <details>
                <summary className="cursor-pointer text-sm text-muted">Archived ({archived.length})</summary>
                <ul className="mt-2 space-y-1 text-sm text-muted">
                  {archived.map((d) => (
                    <li key={d.id}>{d.kind === "other" ? d.title : DOCUMENT_KINDS[d.kind]}{d.reference_number ? ` · ${d.reference_number}` : ""}{d.expires_on ? ` · expired/expires ${formatDate(d.expires_on)}` : ""} · archived {formatDateTime(d.archived_at, timezone)}</li>
                  ))}
                </ul>
              </details>
            )}
            <p className="text-xs text-muted">No reminders are sent: expiry warnings appear here, in the fleet list and on the Fleet overview ({30} days ahead).</p>
          </>
        )}
      </CardBody>
    </Card>
  );
}

export function OwnershipCard({ vehicle, value, canEdit }: { vehicle: { kind: "truck" | "trailer"; id: string }; value: string | null | undefined; canEdit: boolean }) {
  if (!canEdit || value === undefined) return null;
  return (
    <Card>
      <CardHeader title="Ownership" description="How the company holds this vehicle. Lease and title papers go under Documents." />
      <CardBody><OwnershipForm vehicle={vehicle} value={value} /></CardBody>
    </Card>
  );
}

const WO_STATUS: Record<string, string> = {
  reported: "Reported", triaged: "Triaged", scheduled: "Scheduled", in_progress: "In progress", awaiting_parts: "Awaiting parts",
  awaiting_inspection: "Awaiting inspection", completed: "Completed", closed: "Closed", canceled: "Canceled",
};

export function MaintenanceCard({ kind = "truck", vehicleId, records, canSee, canCreate, timezone }: {
  kind?: "truck" | "trailer";
  vehicleId: string;
  records: VehicleRecords;
  canSee: boolean;
  canCreate: boolean;
  timezone: string;
}) {
  // Preventive schedules and readings are truck records; a trailer shows its work orders.
  const isTruck = kind === "truck";
  return (
    <Card>
      <CardHeader
        title="Maintenance"
        description={isTruck ? "Work orders, preventive schedules and readings from Maintenance." : "Work orders from Maintenance."}
        actions={canCreate && records.workOrders.available ? <ButtonLink href={`/maintenance/work-orders/new?${kind}=${vehicleId}`} size="sm" variant="secondary" icon={<Wrench className="size-4" />}>New work order</ButtonLink> : undefined}
      />
      <CardBody className="space-y-5">
        {!canSee ? <p className="text-sm text-muted">Your role cannot see maintenance records.</p> : !records.workOrders.available ? <Unavailable what="Maintenance history" /> : (
          <>
            <div>
              <p className="text-sm font-semibold">Work orders</p>
              {records.workOrders.rows.length === 0 ? <p className="text-sm text-muted">None recorded.</p> : (
                <ul className="mt-1 divide-y divide-line text-sm">
                  {records.workOrders.rows.slice(0, 15).map((w) => (
                    <li key={w.id} className="flex flex-wrap items-center gap-2 py-1.5">
                      <Link href={`/maintenance/work-orders/${w.id}`} className="font-medium hover:underline">{w.number}</Link>
                      <span>{w.title}</span>
                      <Badge tone={["completed", "closed"].includes(w.status) ? "green" : w.status === "canceled" ? "gray" : "amber"}>{WO_STATUS[w.status] ?? w.status}</Badge>
                      {w.safety_critical && <Badge tone="critical-soft">Safety-critical</Badge>}
                      <span className="text-muted">{w.scheduled_for ? `scheduled ${formatDate(w.scheduled_for)} · ` : ""}opened {formatDateTime(w.created_at, timezone)}</span>
                    </li>
                  ))}
                </ul>
              )}
              {records.workOrders.rows.length > 15 && <Link href={`/maintenance/work-orders?${kind}=${vehicleId}&view=all`} className="text-sm underline">All {records.workOrders.rows.length} work orders</Link>}
            </div>
            {isTruck && <div>
              <p className="text-sm font-semibold">Preventive schedules</p>
              {records.schedules.rows.length === 0 ? <p className="text-sm text-muted">None. <Link href={`/maintenance/preventive?truck=${vehicleId}`} className="underline">Add one in Maintenance</Link>.</p> : (
                <ul className="mt-1 space-y-1 text-sm">
                  {records.schedules.rows.map((p) => (
                    <li key={p.schedule_id} className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{p.name}</span>
                      <Badge tone={p.state === "overdue" ? "critical" : p.state === "due_soon" ? "amber" : p.state === "ok" ? "green" : "gray"}>{p.state === "unknown" ? "Not enough data" : p.state.replace("_", " ")}</Badge>
                      <span className="text-muted">{[p.next_due_on && `next ${formatDate(p.next_due_on)}`, p.next_due_miles !== null && `at ${num(Number(p.next_due_miles))} mi`, p.next_due_hours !== null && `at ${num(Number(p.next_due_hours))} h`].filter(Boolean).join(" · ")}</span>
                      {p.readings_stale && <span className="text-xs text-amber-800">reading older than 30 days</span>}
                    </li>
                  ))}
                </ul>
              )}
            </div>}
            {isTruck && <div>
              <p className="flex items-center gap-1.5 text-sm font-semibold"><Gauge className="size-4 text-muted" aria-hidden />Readings</p>
              {records.readings.rows.length === 0 ? <p className="text-sm text-muted">No odometer or engine-hour readings recorded. <Link href="/maintenance/preventive" className="underline">Record one</Link>.</p> : (
                <ul className="mt-1 space-y-0.5 text-sm">
                  {records.readings.rows.slice(0, 5).map((r) => (
                    <li key={r.id} className="tabular">
                      {[r.odometer_miles !== null && `${num(r.odometer_miles)} mi`, r.engine_hours !== null && `${num(r.engine_hours)} h`].filter(Boolean).join(" · ")}
                      <span className="text-muted"> · {formatDateTime(r.read_at, timezone)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>}
          </>
        )}
      </CardBody>
    </Card>
  );
}

/** Recorded costs, recorded mileage and recorded downtime — no estimates. */
export function CostsCard({ records, downtime90, canSeeCosts }: { records: VehicleRecords; downtime90: number; canSeeCosts: boolean }) {
  const odo = records.readings.rows.filter((r) => r.odometer_miles !== null);
  const latest = odo[0];
  const earliest = odo[odo.length - 1];
  const miles = latest && earliest && latest !== earliest ? latest.odometer_miles! - earliest.odometer_miles! : null;
  const total = records.costs.rows.reduce((s, c) => s + Math.round(c.quantity * c.unit_cost_cents), 0);
  // Cost per mile only from costs on work orders opened within the recorded odometer span.
  const inSpan = new Set(records.workOrders.rows.filter((w) => earliest && latest && w.created_at >= earliest.read_at && w.created_at <= latest.read_at).map((w) => w.id));
  const spanCost = records.costs.rows.filter((c) => inSpan.has(c.work_order_id)).reduce((s, c) => s + Math.round(c.quantity * c.unit_cost_cents), 0);
  return (
    <Card>
      <CardHeader title="Costs and utilization" description="Only recorded values. Fuel, insurance premiums and lease payments are not tracked in Taviron yet." />
      <CardBody>
        <DescriptionList items={[
          { label: "Downtime, last 90 days", value: `${num(downtime90)} days out of service` },
          { label: "Recorded miles", value: miles !== null ? `${num(miles)} mi between ${formatDate(earliest.read_at.slice(0, 10))} and ${formatDate(latest.read_at.slice(0, 10))}` : "Needs two odometer readings" },
          ...(canSeeCosts ? [
            { label: "Maintenance costs recorded", value: records.costs.available ? money(total) : "Not available" },
            { label: "Maintenance cost per mile", value: miles && miles > 0 && records.costs.available ? `${money(Math.round((spanCost / miles) * 100) / 100)} / mi (actual: costs on work orders opened in that span ÷ recorded miles)` : "Not enough recorded data" },
          ] : [{ label: "Costs", value: "Visible to people with maintenance cost access." }]),
        ]} />
      </CardBody>
    </Card>
  );
}
