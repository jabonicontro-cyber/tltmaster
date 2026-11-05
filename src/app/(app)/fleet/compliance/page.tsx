import Link from "next/link";
import { FleetNav } from "@/components/fleet/fleet-nav";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState, Notice } from "@/components/ui/states";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { formatDate } from "@/lib/dates";
import { DUE_KIND_LABELS, buildCalendar, daysUntil, dueState, type DueState } from "@/lib/fleet/compliance-calendar";
import { can } from "@/lib/permissions";
import { requirePagePermission } from "@/server/auth";
import { loadCalendarInput } from "@/server/data/compliance";

export const metadata = { title: "Compliance calendar" };

const GROUPS: Array<{ state: DueState; title: string }> = [
  { state: "overdue", title: "Overdue" },
  { state: "soon", title: "Next 30 days" },
  { state: "later", title: "In 31 to 90 days" },
];

/**
 * Compliance calendar (master plan CC1): every due date the company records, in one list. The alerts and dispatch rules
 * on each record are unchanged; this is where to see them all at once.
 */
export default async function ComplianceCalendarPage() {
  const access = await requirePagePermission("fleet.view");
  const { input, missing } = await loadCalendarInput({ maintenance: can(access, "maintenance.view") });
  const items = buildCalendar(input);
  const header = (
    <>
      <PageHeader title="Fleet" description="Trucks, trailers and drivers, with what makes each one ready (or not ready) for work." />
      <FleetNav active="Compliance calendar" />
    </>
  );
  return (
    <>
      {header}
      {missing.length > 0 && (
        <div className="mb-4">
          <Notice tone="warning" title="Part of the calendar couldn't be loaded">Not shown: {missing.join(", ")}. Reload the page; if it keeps happening, those dates may be missing here.</Notice>
        </div>
      )}
      {items.length === 0 ? (
        <Card>
          <EmptyState title="Nothing due in the next 90 days" description="Driver credentials, truck and trailer documents, preventive service and fuel tax deadlines show here as they come up. Records without an expiry date aren't listed." />
        </Card>
      ) : (
        <div className="space-y-5">
          {GROUPS.map((g) => {
            const list = items.filter((i) => dueState(i.due, input.today) === g.state);
            if (!list.length) return null;
            return (
              <Card key={g.state}>
                <h2 className="flex items-center gap-2 px-5 pt-4 pb-2 text-base font-semibold text-ink sm:px-6">
                  {g.title} <Badge tone={g.state === "overdue" ? "critical" : g.state === "soon" ? "amber" : "gray"}>{list.length}</Badge>
                </h2>
                <TableWrap>
                  <Table aria-label={g.title}>
                    <thead>
                      <tr><Th>Due</Th><Th>What</Th><Th>For</Th><Th className="hidden md:table-cell">Kind</Th></tr>
                    </thead>
                    <tbody>
                      {list.map((i) => {
                        const d = daysUntil(i.due, input.today);
                        return (
                          <Tr key={i.key}>
                            <Td className="whitespace-nowrap">
                              <span className="font-semibold text-ink">{formatDate(i.due)}</span>
                              <div className={g.state === "overdue" ? "text-xs font-semibold text-critical" : "text-xs text-muted"}>
                                {d < 0 ? `${-d} ${-d === 1 ? "day" : "days"} overdue` : d === 0 ? "Today" : `In ${d} ${d === 1 ? "day" : "days"}`}
                              </div>
                            </Td>
                            <Td><Link href={i.href} className="font-semibold hover:text-brand-fg hover:underline">{i.what}</Link></Td>
                            <Td>{i.subject}</Td>
                            <Td className="hidden text-sm text-muted md:table-cell">{DUE_KIND_LABELS[i.kind]}</Td>
                          </Tr>
                        );
                      })}
                    </tbody>
                  </Table>
                </TableWrap>
              </Card>
            );
          })}
        </div>
      )}
    </>
  );
}
