import Link from "next/link";
import { Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/form";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState, Notice } from "@/components/ui/states";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { SubmitButton } from "@/components/ui/submit-button";
import { cn } from "@/lib/cn";
import { formatDateTime } from "@/lib/dates";
import { can } from "@/lib/permissions";
import { SUPPORT_KINDS, SUPPORT_STATUS_STAFF, hoursWaiting } from "@/lib/support";
import { requirePagePermission } from "@/server/auth";
import { getUserNames } from "@/server/data/quotes";
import { businessToday } from "@/server/data/settings";
import { listSupportCases, supportOverdue, type SupportFilter } from "@/server/data/support";
import { createClient } from "@/server/supabase/server";
import { saveSupportTarget } from "./actions";

export const metadata = { title: "Support" };

const FILTERS: Array<[SupportFilter, string]> = [["open", "Open"], ["mine", "Mine"], ["unassigned", "Unassigned"], ["closed", "Closed"], ["all", "All"]];

/** Support center (B138): every customer case, from the portal or opened by the office, with type, owner and wait. */
export default async function SupportPage({ searchParams }: { searchParams: Promise<{ filter?: string; saved?: string; error?: string }> }) {
  const access = await requirePagePermission("customers.view");
  const sp = await searchParams;
  const filter = (FILTERS.find(([k]) => k === sp.filter)?.[0] ?? "open") as SupportFilter;
  const [{ installed, cases }, overdue, names, { timezone }, settings] = await Promise.all([
    listSupportCases(filter, access.userId), supportOverdue(), getUserNames(), businessToday(),
    (async () => (await (await createClient()).from("support_settings").select("first_reply_hours").maybeSingle()).data as { first_reply_hours: number | null } | null)(),
  ]);
  const target = settings?.first_reply_hours ?? null;
  const now = new Date();
  const header = (
    <PageHeader title="Support" description="Customer cases from the portal and the ones you open for customers: delivery problems, billing questions, wrong material, anything else."
      actions={can(access, "customers.edit") ? <Link href="/support/new" className={buttonClasses("primary", "md")}><Plus className="size-4" aria-hidden /> New case</Link> : undefined} />
  );
  if (!installed) return <>{header}<Notice title="Not available yet">The support center needs a database update that has not been installed yet.</Notice></>;
  return (
    <>
      {header}
      {sp.error ? <div className="mb-4"><Notice tone="warning" title="Not saved">{sp.error}</Notice></div> : null}
      {sp.saved === "target" ? <p role="status" className="mb-4 text-sm text-muted">Reply target saved.</p> : null}
      {overdue.count > 0 && (
        <p role="alert" className="mb-4 rounded-panel border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950">
          <span className="font-semibold">{overdue.count} case{overdue.count === 1 ? "" : "s"} waiting longer than {overdue.targetHours} h</span> for a first reply.
        </p>
      )}
      <nav aria-label="Support filters" className="mb-4 flex w-fit max-w-full gap-1 overflow-x-auto rounded-full bg-ink/[0.05] p-1">
        {FILTERS.map(([k, l]) => (
          <Link key={k} href={`/support?filter=${k}`} aria-current={k === filter ? "page" : undefined}
            className={cn("rounded-full px-3 py-1.5 text-sm font-semibold whitespace-nowrap", k === filter ? "bg-card text-ink shadow-xs" : "text-muted hover:text-ink")}>{l}</Link>
        ))}
      </nav>
      {cases.length === 0 ? (
        <Card><EmptyState title={filter === "open" ? "No open cases" : "No cases here"} description="Cases customers send from the portal and the ones you open appear here." /></Card>
      ) : (
        <TableWrap>
          <Table aria-label="Support cases">
            <thead><Tr><Th>Case</Th><Th>Customer</Th><Th>Type</Th><Th>Assigned</Th><Th>Status</Th><Th align="right">Updated</Th></Tr></thead>
            <tbody>
              {cases.map((c) => {
                const late = target !== null && c.status === "open" && !c.first_reply_at && hoursWaiting(c.created_at, now) >= target;
                return (
                  <Tr key={c.id}>
                    <Td><Link href={`/support/${c.id}`} className="font-semibold text-ink hover:underline">{c.subject}</Link>{!c.from_portal && <span className="ml-2 text-xs text-muted">opened by the office</span>}</Td>
                    <Td>{c.customer_name}</Td>
                    <Td>{SUPPORT_KINDS[c.kind] ?? "Other"}</Td>
                    <Td>{c.assigned_to ? names[c.assigned_to] ?? "Former member" : <span className="text-muted">Nobody</span>}</Td>
                    <Td>
                      <span className="flex flex-wrap gap-1.5">
                        <Badge tone={c.status === "open" ? "brand" : c.status === "answered" ? "green" : "gray"}>{SUPPORT_STATUS_STAFF[c.status]}</Badge>
                        {late && <Badge tone="amber">Waiting {hoursWaiting(c.created_at, now)} h</Badge>}
                      </span>
                    </Td>
                    <Td align="right" className="whitespace-nowrap text-sm text-muted">{formatDateTime(c.updated_at, timezone)}</Td>
                  </Tr>
                );
              })}
            </tbody>
          </Table>
        </TableWrap>
      )}
      <Card className="mt-5">
        <CardHeader title="First-reply target" description={target ? `Cases without a first reply after ${target} hours are flagged here and on the Command Center.` : "Off. Set a number of hours to flag cases that wait too long for a first reply."} />
        {can(access, "settings.manage") && (
          <CardBody>
            <form action={saveSupportTarget} className="flex flex-wrap items-end gap-2">
              <label className="text-sm font-medium text-ink" htmlFor="sup-hours">Hours<Input id="sup-hours" name="hours" inputMode="numeric" defaultValue={target ?? ""} placeholder="Off" className="mt-1 w-28" /></label>
              <SubmitButton variant="secondary" size="sm">Save target</SubmitButton>
            </form>
          </CardBody>
        )}
      </Card>
    </>
  );
}
