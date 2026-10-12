import Link from "next/link";
import { notFound } from "next/navigation";
import { AlertActions } from "@/components/communications/alert-actions";
import { Poller } from "@/components/communications/poller";
import { CommunicationsUnavailable } from "@/components/communications/unavailable";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { DescriptionList } from "@/components/ui/description-list";
import { PageHeader } from "@/components/ui/page-header";
import { ACK_SCOPES, ALERT_EVENT_LABELS, PRIORITIES, PRIORITY_TONE, type Priority } from "@/lib/communications";
import { formatDateTime } from "@/lib/dates";
import { can } from "@/lib/permissions";
import { requireAccess } from "@/server/auth";
import { loadAlert, loadDirectory } from "@/server/data/communications";

export const metadata = { title: "Alert" };

const REASONS: Record<string, string> = { designated: "Designated", escalation: "Escalation", reassigned: "Reassigned", informed: "For information" };

function eventText(kind: string, d: Record<string, unknown>, name: (id: unknown) => string) {
  switch (kind) {
    case "priority_changed": return `${PRIORITIES[d.from as Priority] ?? d.from} → ${PRIORITIES[d.to as Priority] ?? d.to}${d.reason ? ` — ${d.reason}` : ""}`;
    case "reassigned": return `${name(d.from)} → ${name(d.to)}${d.reason ? ` — ${d.reason}` : ""}`;
    case "escalated": return `Level ${d.level}: ${Array.isArray(d.to) ? (d.to as unknown[]).map(name).join(", ") || "nobody in the escalation roles" : ""}`;
    case "resolved": return String(d.note ?? "");
    case "occurred_again": return String(d.detail ?? "");
    case "created": return PRIORITIES[d.priority as Priority] ?? "";
    case "escalation_canceled": return String(d.reason ?? "");
    default: return "";
  }
}

export default async function AlertPage({ params }: { params: Promise<{ id: string }> }) {
  const access = await requireAccess();
  const { id } = await params;
  const [data, directory] = await Promise.all([loadAlert(id), loadDirectory()]);
  if (data === undefined) return <CommunicationsUnavailable title="Alert" />;
  if (data === null) notFound();
  const { alert: a, type, recipients, acks, events } = data;
  const names = new Map((directory ?? []).map((p) => [p.user_id, p.name]));
  const name = (u: unknown) => (typeof u === "string" ? names.get(u) ?? "Former employee" : "Taviron");
  const acked = new Set(acks.map((k) => k.user_id));
  const activeResp = recipients.filter((r) => r.responsible && !r.released_at);
  const outstanding = a.status !== "open" || a.priority === "informational" ? []
    : a.ack_scope === "any" ? (recipients.some((r) => acked.has(r.user_id)) ? [] : activeResp)
    : activeResp.filter((r) => (r.reason === "designated" || r.reason === "reassigned") && !acked.has(r.user_id));
  const meResponsible = activeResp.some((r) => r.user_id === access.userId);
  const canAcknowledge = a.status === "open" && a.priority !== "informational" && meResponsible && !acked.has(access.userId);

  return (
    <>
      <Poller />
      <PageHeader
        title={a.title}
        crumbs={[{ label: "Alerts", href: "/communications/alerts" }]}
        badges={<>
          <Badge tone={PRIORITY_TONE[a.priority]}>{PRIORITIES[a.priority]}</Badge>
          {a.status === "open" ? <Badge tone="blue">Open</Badge> : <Badge tone="green">Resolved</Badge>}
          {a.escalation_level > 0 && a.status === "open" && <Badge tone="critical-soft">Escalated (level {a.escalation_level})</Badge>}
        </>}
        actions={<AlertActions
          id={a.id}
          priority={a.priority}
          minPriority={type.min_priority}
          open={a.status === "open"}
          canAcknowledge={canAcknowledge}
          canManage={can(access, "comms.alerts")}
          recipients={activeResp.map((r) => ({ user_id: r.user_id, name: name(r.user_id) }))}
          people={(directory ?? []).map((p) => ({ user_id: p.user_id, name: p.name }))}
        />}
      />
      <div className="grid gap-5 xl:grid-cols-2">
        <Card>
          <CardHeader title="Details" />
          <CardBody>
            <DescriptionList items={[
              { label: "Type", value: type.label },
              { label: "Details", value: a.detail || "—" },
              { label: "Source", value: a.link ? <Link className="text-brand-fg hover:underline" href={a.link}>Open the related record</Link> : "—" },
              { label: "Raised", value: formatDateTime(a.created_at) },
              { label: "Occurrences", value: a.occurrences > 1 ? `${a.occurrences} (last ${formatDateTime(a.last_occurred_at)})` : "1" },
              { label: "Acknowledgment", value: a.priority === "informational" ? "Not required (informational)" : ACK_SCOPES[a.ack_scope] },
              { label: "Minimum priority", value: PRIORITIES[type.min_priority] },
              ...(a.status === "open" && a.escalation_due_at ? [{ label: "Escalates", value: `${formatDateTime(a.escalation_due_at)} if not acknowledged` }] : []),
              ...(a.status === "resolved" ? [{ label: "Resolved", value: `${formatDateTime(a.resolved_at)} by ${name(a.resolved_by)} — ${a.resolution_note || "no note"}` }] : []),
            ]} />
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Recipients" description={outstanding.length > 0 ? `Waiting for acknowledgment from ${outstanding.map((r) => name(r.user_id)).join(", ")}.` : a.status === "open" && a.priority !== "informational" ? "Acknowledged." : undefined} />
          <ul className="divide-y divide-line">
            {recipients.map((r) => {
              const k = acks.find((x) => x.user_id === r.user_id);
              return (
                <li key={r.id} className="flex flex-wrap items-center gap-2 px-4 py-2 text-sm">
                  <span className="min-w-0 flex-1 text-ink">{name(r.user_id)}</span>
                  <Badge tone="gray">{REASONS[r.reason] ?? r.reason}</Badge>
                  {r.released_at ? <span className="text-xs text-muted">No longer responsible</span>
                    : k ? <span className="text-xs text-green-800">Acknowledged {formatDateTime(k.acknowledged_at)}</span>
                    : r.responsible && a.priority !== "informational" ? <span className="text-xs text-muted">Not acknowledged</span> : null}
                </li>
              );
            })}
          </ul>
        </Card>
      </div>
      <Card className="mt-5">
        <CardHeader title="History" />
        <ol className="divide-y divide-line">
          {events.map((e) => (
            <li key={e.id} className="flex flex-wrap gap-x-3 px-4 py-2 text-sm">
              <span className="w-44 shrink-0 text-xs text-muted">{formatDateTime(e.created_at)}</span>
              <span className="font-medium text-ink">{ALERT_EVENT_LABELS[e.kind] ?? e.kind}</span>
              <span className="min-w-0 flex-1 text-muted">{eventText(e.kind, e.details, name)}{e.actor_id ? ` · ${name(e.actor_id)}` : ""}</span>
            </li>
          ))}
        </ol>
      </Card>
    </>
  );
}
