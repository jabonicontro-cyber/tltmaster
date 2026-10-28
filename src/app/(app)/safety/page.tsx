import Link from "next/link";
import { redirect } from "next/navigation";
import { AlertTriangle, CheckCircle2, ClipboardList, Clock, Plus, ShieldAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { FilterBar, FilterSelect } from "@/components/ui/filter-bar";
import { PageHeader } from "@/components/ui/page-header";
import { StatTile } from "@/components/ui/stat-tile";
import { EmptyState, Notice } from "@/components/ui/states";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { addDays, formatDateTime } from "@/lib/dates";
import { can } from "@/lib/permissions";
import { INCIDENT_KINDS, INCIDENT_SEVERITIES, INCIDENT_STATUSES, STATUS_TONE } from "@/lib/safety";
import { requireAccess } from "@/server/auth";
import { listIncidents } from "@/server/data/safety";
import { businessToday } from "@/server/data/settings";

export const metadata = { title: "Safety" };

/**
 * Safety incidents (B103, migration 20261120004300): accidents, injuries, damage, spills and near misses with their
 * investigation and corrective actions. safety.view reads; safety.manage reports for anyone, investigates and closes.
 */
export default async function SafetyPage({ searchParams }: { searchParams: Promise<{ status?: string; q?: string }> }) {
  const access = await requireAccess();
  if (!can(access, "safety.view")) redirect(can(access, "driver.portal") ? "/driver/safety" : "/no-access?missing=safety.view");
  const sp = await searchParams;
  const { today, timezone } = await businessToday();
  const status = sp.status ?? "open";
  const [list, all] = await Promise.all([listIncidents({ status, q: sp.q }, today), listIncidents({}, today)]);
  const manage = can(access, "safety.manage");

  const open = all.rows.filter((r) => r.status !== "closed");
  const overdue = all.rows.reduce((n, r) => n + r.overdue_actions, 0);
  const since = addDays(today, -89);
  const closed90 = all.rows.filter((r) => r.status === "closed" && r.occurred_at.slice(0, 10) >= since).length;
  const serious = open.filter((r) => r.severity === "serious" || r.injury).length;

  return (
    <>
      <PageHeader
        title="Safety"
        description="Accidents, injuries, damage, spills and near misses: what happened, what was found and what was done about it."
        actions={manage && <ButtonLink href="/safety/new" icon={<Plus className="size-4" />}>Report incident</ButtonLink>}
      />
      {!list.installed ? (
        <Notice title="Not available yet">Safety incidents need a database update that has not been installed yet.</Notice>
      ) : (
        <>
          <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="Safety at a glance">
            <StatTile icon={<ShieldAlert />} tone={open.length ? "amber" : "neutral"} label="Open incidents" value={open.length} muted={open.length === 0}>
              <Link href="/safety?status=open" className="text-muted underline-offset-2 hover:underline"><span className="sr-only">{open.length} </span>reported or under investigation</Link>
            </StatTile>
            <StatTile icon={<AlertTriangle />} tone={serious ? "critical" : "neutral"} label="Serious or injury" value={serious} muted={serious === 0}>
              <span className="text-muted"><span className="sr-only">{serious} </span>among the open ones</span>
            </StatTile>
            <StatTile icon={<Clock />} tone={overdue ? "critical" : "neutral"} label="Actions overdue" value={overdue} muted={overdue === 0}>
              <span className="text-muted"><span className="sr-only">{overdue} </span>{overdue ? "past their due date" : "nothing overdue"}</span>
            </StatTile>
            <StatTile icon={<CheckCircle2 />} tone="green" label="Closed, last 90 days" value={closed90} muted={closed90 === 0}>
              <Link href="/safety?status=closed" className="text-muted underline-offset-2 hover:underline"><span className="sr-only">{closed90} </span>investigated and done</Link>
            </StatTile>
          </div>
          <Card>
            <FilterBar action="/safety" query={sp.q} placeholder="Search number, place, truck, driver…" clearHref="/safety">
              <FilterSelect name="status" label="Status" value={status} options={[
                { value: "open", label: "Open" },
                ...Object.entries(INCIDENT_STATUSES).map(([value, label]) => ({ value, label })),
                { value: "all", label: "All" },
              ]} />
            </FilterBar>
            {list.rows.length === 0 ? (
              <EmptyState
                icon={<ClipboardList className="size-6" />}
                title={sp.q || status !== "open" ? "No incidents match" : "No open incidents"}
                description={manage ? "Report an incident here; drivers report from their phone." : "Incidents appear here when they are reported."}
              />
            ) : (
              <TableWrap>
                <Table>
                  <thead>
                    <tr><Th>Incident</Th><Th className="hidden md:table-cell">When and where</Th><Th className="hidden lg:table-cell">Truck · driver</Th><Th>Status</Th></tr>
                  </thead>
                  <tbody>
                    {list.rows.map((r) => (
                      <Tr key={r.id}>
                        <Td>
                          <Link href={`/safety/${r.id}`} className="font-semibold tabular hover:text-brand-fg hover:underline">{r.number}</Link>
                          <span className="ml-2 text-sm">{INCIDENT_KINDS[r.kind]}</span>
                          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs">
                            <Badge tone={r.severity === "serious" ? "red" : r.severity === "moderate" ? "amber" : "gray"}>{INCIDENT_SEVERITIES[r.severity]}</Badge>
                            {r.injury && <Badge tone="red">Injury</Badge>}
                            {r.vehicle_damage && <Badge tone="gray">Vehicle damage</Badge>}
                          </div>
                          <div className="mt-1 line-clamp-1 max-w-md text-sm text-muted md:hidden">{formatDateTime(r.occurred_at, timezone)}</div>
                        </Td>
                        <Td className="hidden md:table-cell">
                          <div className="tabular">{formatDateTime(r.occurred_at, timezone)}</div>
                          <div className="max-w-xs truncate text-sm text-muted">{r.location || "—"}</div>
                        </Td>
                        <Td className="hidden lg:table-cell">{r.truck ?? "—"} · {r.driver ?? "—"}</Td>
                        <Td>
                          <Badge tone={STATUS_TONE[r.status]}>{INCIDENT_STATUSES[r.status]}</Badge>
                          {r.open_actions > 0 && (
                            <div className={r.overdue_actions ? "mt-1 text-xs font-semibold text-critical" : "mt-1 text-xs text-muted"}>
                              {r.open_actions} action{r.open_actions === 1 ? "" : "s"} open{r.overdue_actions ? ` · ${r.overdue_actions} overdue` : ""}
                            </div>
                          )}
                        </Td>
                      </Tr>
                    ))}
                  </tbody>
                </Table>
              </TableWrap>
            )}
          </Card>
        </>
      )}
    </>
  );
}
