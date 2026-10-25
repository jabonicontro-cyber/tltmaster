import Link from "next/link";
import { ShieldAlert } from "lucide-react";
import { Poller } from "@/components/communications/poller";
import { CommunicationsTabs } from "@/components/communications/tabs";
import { CommunicationsUnavailable } from "@/components/communications/unavailable";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/states";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { cn } from "@/lib/cn";
import { PRIORITIES, PRIORITY_RANK, PRIORITY_TONE } from "@/lib/communications";
import { formatDateTime } from "@/lib/dates";
import { can } from "@/lib/permissions";
import { requireAccess } from "@/server/auth";
import { loadAlertCounts, loadAlerts } from "@/server/data/communications";

export const metadata = { title: "Alerts" };

const STATUSES = { open: "Open", resolved: "Resolved", all: "All" } as const;

export default async function AlertsPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const access = await requireAccess();
  const sp = await searchParams;
  const status = (sp.status && sp.status in STATUSES ? sp.status : "open") as keyof typeof STATUSES;
  const data = await loadAlerts(status);
  if (!data) return <CommunicationsUnavailable title="Alerts" />;
  const counts = await loadAlertCounts();
  const types = new Map(data.types.map((t) => [t.code, t]));
  const rows = [...data.alerts].sort((a, b) => (a.status === b.status ? PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority] || b.created_at.localeCompare(a.created_at) : a.status === "open" ? -1 : 1));
  return (
    <>
      <Poller />
      <PageHeader title="Alerts" description={can(access, "comms.alerts")
        ? "Operational alerts for the company: safety restrictions, breakdowns, time off, documents and acknowledgments. Alerts are kept separate from conversations."
        : "Alerts addressed to you."} />
      <CommunicationsTabs active="alerts" counts={{ alerts: counts?.open, critical: counts?.critical }} />
      {counts && counts.mine > 0 && (
        <p className="mb-4 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950">
          {counts.mine} alert{counts.mine === 1 ? " is" : "s are"} waiting for your acknowledgment.
        </p>
      )}
      <Card>
        <CardHeader title={`${STATUSES[status]} alerts`} actions={
          <nav aria-label="Filter alerts" className="flex gap-1">
            {(Object.keys(STATUSES) as Array<keyof typeof STATUSES>).map((s) => (
              <Link key={s} href={s === "open" ? "/communications/alerts" : `/communications/alerts?status=${s}`} aria-current={s === status ? "page" : undefined}
                className={cn("rounded px-2 py-1 text-xs font-semibold", s === status ? "bg-strong text-white" : "text-muted hover:bg-surface hover:text-ink")}>{STATUSES[s]}</Link>
            ))}
          </nav>
        } />
        {rows.length === 0 ? <EmptyState icon={<ShieldAlert className="size-6" />} title={status === "open" ? "No open alerts" : "No alerts"} /> : (
          <TableWrap>
            <Table>
              <thead><tr><Th>Priority</Th><Th>Alert</Th><Th className="hidden md:table-cell">Type</Th><Th className="hidden sm:table-cell">Raised</Th><Th>Status</Th></tr></thead>
              <tbody>
                {rows.map((a) => (
                  <Tr key={a.id}>
                    <Td><Badge tone={PRIORITY_TONE[a.priority]}>{PRIORITIES[a.priority]}</Badge></Td>
                    <Td>
                      <Link href={`/communications/alerts/${a.id}`} className="font-medium text-ink hover:underline">{a.title}</Link>
                      {a.occurrences > 1 && <span className="ml-2 text-xs text-muted">×{a.occurrences}</span>}
                      {data.mine.has(a.id) && <span className="ml-2 text-xs font-semibold text-muted">Addressed to you</span>}
                    </Td>
                    <Td className="hidden md:table-cell">{types.get(a.event_type)?.label ?? a.event_type}</Td>
                    <Td className="hidden sm:table-cell">{formatDateTime(a.created_at)}</Td>
                    <Td>{a.status === "open" ? (a.escalation_level > 0 ? <Badge tone="critical-soft">Escalated</Badge> : <Badge tone="blue">Open</Badge>) : <Badge tone="green">Resolved</Badge>}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </TableWrap>
        )}
      </Card>
    </>
  );
}
