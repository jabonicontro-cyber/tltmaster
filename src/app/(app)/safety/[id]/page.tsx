import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { ActionForm, CloseIncidentForm, CompleteActionButton, InvestigationForm, WitnessForm } from "@/components/safety/incident-manage";
import { cn } from "@/lib/cn";
import { formatDate, formatDateTime } from "@/lib/dates";
import { can } from "@/lib/permissions";
import { INCIDENT_KINDS, INCIDENT_SEVERITIES, INCIDENT_STATUSES, STATUS_TONE } from "@/lib/safety";
import { requirePagePermission } from "@/server/auth";
import { getUserNames } from "@/server/data/quotes";
import { getIncident } from "@/server/data/safety";
import { businessToday } from "@/server/data/settings";

export const metadata = { title: "Safety incident" };

const EVENT_LABELS: Record<string, string> = {
  reported: "Reported",
  "photo added": "Photo added",
  "investigation saved": "Investigation saved",
  "witness added": "Witness added",
  "action added": "Corrective action added",
  "action done": "Corrective action done",
  closed: "Closed",
};

/** One incident: the report as made, photos, witnesses, the investigation, corrective actions and the timeline. */
export default async function IncidentPage({ params }: { params: Promise<{ id: string }> }) {
  const access = await requirePagePermission("safety.view");
  const { id } = await params;
  const [incident, names, { today, timezone }] = await Promise.all([getIncident(id), getUserNames(), businessToday()]);
  if (!incident) notFound();
  const manage = can(access, "safety.manage");
  const closed = incident.status === "closed";
  const people = Object.entries(names).map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label));
  const who = (u: string | null) => (u ? names[u] ?? "Former user" : "—");
  const blocked = !incident.findings.trim() ? "Record the findings in the investigation before closing." : incident.open_actions ? "Every corrective action must be done before closing." : null;

  return (
    <>
      <PageHeader
        title={`${incident.number} · ${INCIDENT_KINDS[incident.kind]}`}
        crumbs={[{ label: "Safety", href: "/safety" }]}
        badges={
          <>
            <Badge tone={STATUS_TONE[incident.status]}>{INCIDENT_STATUSES[incident.status]}</Badge>
            <Badge tone={incident.severity === "serious" ? "red" : incident.severity === "moderate" ? "amber" : "gray"}>{INCIDENT_SEVERITIES[incident.severity]}</Badge>
            {incident.injury && <Badge tone="red">Injury</Badge>}
            {incident.vehicle_damage && <Badge tone="gray">Vehicle damage</Badge>}
          </>
        }
        description={`${formatDateTime(incident.occurred_at, timezone)}${incident.location ? ` · ${incident.location}` : ""}`}
      />
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0 space-y-5">
          <Card>
            <CardHeader title="The report" description={`Reported by ${who(incident.reported_by)} on ${formatDateTime(incident.reported_at, timezone)}. Kept as it was reported.`} />
            <CardBody className="space-y-3">
              <p className="whitespace-pre-line">{incident.description}</p>
              <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
                <div><dt className="text-muted">Truck</dt><dd className="font-medium">{incident.truck ?? "—"}</dd></div>
                <div><dt className="text-muted">Driver</dt><dd className="font-medium">{incident.driver ?? "—"}</dd></div>
                <div><dt className="text-muted">Order</dt><dd className="font-medium tabular">{incident.order_number ?? "—"}</dd></div>
              </dl>
              {incident.photos.length > 0 && (
                <ul className="flex flex-wrap gap-2" aria-label="Photos">
                  {incident.photos.map((p, i) => (
                    <li key={p.id}>
                      <a href={`/safety/photos/${p.id}`} target="_blank" rel="noopener noreferrer" className="block size-24 overflow-hidden rounded-lg ring-1 ring-line">
                        {/* eslint-disable-next-line @next/next/no-img-element -- short-lived signed link */}
                        <img src={`/safety/photos/${p.id}`} alt={`Photo ${i + 1}`} loading="lazy" className="size-full object-cover" />
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Investigation" description="What was found and why it happened." />
            <CardBody>
              {manage && !closed ? (
                <InvestigationForm id={incident.id} kind={incident.kind} severity={incident.severity} findings={incident.findings} rootCause={incident.root_cause} />
              ) : (
                <dl className="space-y-2 text-sm">
                  <div><dt className="text-muted">Findings</dt><dd className="whitespace-pre-line">{incident.findings || "Not recorded yet."}</dd></div>
                  <div><dt className="text-muted">Root cause</dt><dd>{incident.root_cause || "—"}</dd></div>
                  {closed && <div><dt className="text-muted">Closed</dt><dd>{formatDateTime(incident.closed_at!, timezone)}{incident.closed_note ? ` · ${incident.closed_note}` : ""}</dd></div>}
                </dl>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Corrective actions" description="Closing needs every action done." />
            {incident.actions.length > 0 && (
              <ul className="divide-y divide-line border-t border-line" aria-label="Corrective actions">
                {incident.actions.map((a) => {
                  const late = a.status === "open" && a.due_on && a.due_on < today;
                  return (
                    <li key={a.id} className="flex flex-wrap items-start gap-3 px-5 py-3 sm:px-6" aria-label={a.description}>
                      <div className="min-w-0 flex-1">
                        <p className={cn("font-medium", a.status === "done" && "text-muted line-through decoration-muted/50")}>{a.description}</p>
                        <p className={cn("text-sm", late ? "font-semibold text-critical" : "text-muted")}>
                          {a.assigned_to ? who(a.assigned_to) : "Unassigned"}{a.due_on ? ` · due ${formatDate(a.due_on)}` : ""}{late ? " · overdue" : ""}
                          {a.status === "done" && a.done_at ? ` · done ${formatDateTime(a.done_at, timezone)}${a.done_note ? ` (${a.done_note})` : ""}` : ""}
                        </p>
                      </div>
                      {a.status === "open" && (manage || a.assigned_to === access.userId) && <CompleteActionButton incidentId={incident.id} actionId={a.id} />}
                      {a.status === "done" && <Badge tone="green">Done</Badge>}
                    </li>
                  );
                })}
              </ul>
            )}
            {manage && !closed && <CardBody className="border-t border-line"><ActionForm id={incident.id} people={people} today={today} /></CardBody>}
            {incident.actions.length === 0 && (!manage || closed) && <CardBody><p className="text-sm text-muted">No corrective actions.</p></CardBody>}
          </Card>
        </div>

        <div className="min-w-0 space-y-5">
          <Card>
            <CardHeader title="Witnesses" />
            {incident.witnesses.length > 0 && (
              <ul className="divide-y divide-line border-t border-line" aria-label="Witnesses">
                {incident.witnesses.map((w) => (
                  <li key={w.id} className="px-5 py-3 text-sm sm:px-6">
                    <p className="font-medium">{w.name}{w.phone ? <span className="font-normal text-muted"> · {w.phone}</span> : null}</p>
                    {w.statement && <p className="mt-0.5 whitespace-pre-line text-muted">“{w.statement}”</p>}
                  </li>
                ))}
              </ul>
            )}
            {manage && !closed ? <CardBody className="border-t border-line"><WitnessForm id={incident.id} /></CardBody> : incident.witnesses.length === 0 && <CardBody><p className="text-sm text-muted">No witnesses recorded.</p></CardBody>}
          </Card>
          {manage && !closed && (
            <Card>
              <CardHeader title="Close the incident" />
              <CardBody><CloseIncidentForm id={incident.id} blocked={blocked} /></CardBody>
            </Card>
          )}
          <Card>
            <CardHeader title="Timeline" />
            <ol className="space-y-2 px-5 pb-5 text-sm sm:px-6" aria-label="Timeline">
              {incident.events.map((e) => (
                <li key={e.id}>
                  <span className="font-medium">{EVENT_LABELS[e.action] ?? e.action}</span>
                  {e.note ? <span className="text-muted"> · {e.note}</span> : null}
                  <div className="text-xs text-muted">{formatDateTime(e.at, timezone)} · {who(e.actor)}</div>
                </li>
              ))}
            </ol>
          </Card>
        </div>
      </div>
    </>
  );
}
