import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { DateInput } from "@/components/ui/date-input";
import { FlashToast } from "@/components/ui/flash-toast";
import { Checkbox, Field, Select } from "@/components/ui/form";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState, ErrorState, Notice } from "@/components/ui/states";
import { SubmitButton } from "@/components/ui/submit-button";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { formatDate } from "@/lib/dates";
import { centsText } from "@/lib/payroll/export";
import { PERIOD_STATUS } from "@/lib/payroll/labels";
import { requirePagePermission } from "@/server/auth";
import { loadPayrollHome } from "@/server/data/payroll";
import { createPeriod, savePayrollSettings } from "./actions";

export const metadata = { title: "Payroll" };


/**
 * Driver payroll from delivery tickets (docs/PAYROLL.md). Owner-only by default (payroll.manage, checked on the server
 * and in the database). Nothing is calculated until the company has an active pay rule it approved and turns
 * calculation on; Taviron calculates gross earnings only.
 */
export default async function PayrollPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  await requirePagePermission("payroll.manage");
  const sp = await searchParams;
  const home = await loadPayrollHome();
  if (!home) {
    return (
      <>
        <PageHeader title="Payroll" />
        <ErrorState title="Payroll needs a database update" description="Apply migration 20261118000200 (owner step). Delivery tickets keep working as before." />
      </>
    );
  }
  const active = home.rules.flatMap((r) => r.versions.filter((v) => v.status === "active"));
  const drafts = home.rules.flatMap((r) => r.versions.filter((v) => v.status === "draft"));
  return (
    <>
      <FlashToast messages={{ saved: { text: "Saved." } }} />
      <PageHeader
        title="Payroll"
        description="Driver earnings from verified delivery tickets, with your company's own pay rules. Gross earnings only — no taxes, withholding or payments."
        actions={<Link href="/payroll/rules" className="text-sm font-semibold text-brand-fg hover:underline">Pay rules</Link>}
      />
      {sp.error && <div className="mb-4"><Notice tone="warning" title="Not saved">{sp.error}</Notice></div>}
      {!home.settings.enabled && (
        <div className="mb-5">
          <Notice title="Calculation is off">
            {active.length === 0
              ? `No pay rule is active yet${drafts.length ? ` (${drafts.length} draft${drafts.length === 1 ? "" : "s"} waiting for approval)` : ""}. Write your rule in Pay rules, preview it on real tickets, compare it with past payroll, then activate it.`
              : "A rule is active. Turn calculation on below when you are ready to calculate earnings for a period."}
          </Notice>
        </div>
      )}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1fr_360px]">
        <Card>
          <CardHeader title="Payroll periods" description="Open a period, calculate it from verified tickets, review exceptions, approve and export." />
          {home.periods.length === 0 ? (
            <EmptyState title="No payroll periods yet" description="Create the first one on the right." className="py-8" />
          ) : (
            <TableWrap className="rounded-none border-0">
              <Table>
                <thead><tr><Th>Period</Th><Th>Status</Th><Th align="right">Drivers</Th><Th align="right">Gross earnings</Th></tr></thead>
                <tbody>
                  {home.periods.map((p) => (
                    <Tr key={p.id}>
                      <Td><Link href={`/payroll/periods/${p.id}`} className="font-semibold hover:underline">{formatDate(p.starts_on)} – {formatDate(p.ends_on)}</Link></Td>
                      <Td><Badge tone={PERIOD_STATUS[p.status]?.tone ?? "gray"}>{PERIOD_STATUS[p.status]?.label ?? p.status}</Badge></Td>
                      <Td align="right">{p.totals ? p.totals.drivers.length : "—"}</Td>
                      <Td align="right" className="tabular">{p.totals ? `$${centsText(p.totals.total_cents)}` : <span className="text-muted">Not approved yet</span>}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </TableWrap>
          )}
        </Card>
        <div className="space-y-5">
          <Card>
            <CardHeader title="New period" />
            <CardBody>
              <form action={createPeriod} className="space-y-3">
                <Field label="First day" htmlFor="starts_on"><DateInput id="starts_on" name="starts_on" required /></Field>
                <Field label="Last day" htmlFor="ends_on"><DateInput id="ends_on" name="ends_on" required /></Field>
                <SubmitButton pendingLabel="Creating…">Create period</SubmitButton>
              </form>
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Settings" description="Who can see payroll: People → Sign-ins & roles (payroll access is the owner's by default)." />
            <CardBody>
              <form action={savePayrollSettings} className="space-y-3">
                <Checkbox name="enabled" defaultChecked={home.settings.enabled} label="Calculate earnings from verified tickets" />
                <p className="-mt-1 text-xs text-muted">Needs at least one active pay rule. Tickets become payable when the office accepts them.</p>
                <Field label="Pay period" htmlFor="period_length">
                  <Select id="period_length" name="period_length" defaultValue={home.settings.period_length ?? ""}>
                    <option value="">Not set</option>
                    <option value="weekly">Weekly</option>
                    <option value="biweekly">Every two weeks</option>
                    <option value="semimonthly">Twice a month</option>
                    <option value="monthly">Monthly</option>
                  </Select>
                </Field>
                <Field label="A period starts on" htmlFor="period_anchor" hint="Any first day of a period; later periods follow from it.">
                  <DateInput id="period_anchor" name="period_anchor" defaultValue={home.settings.period_anchor ?? ""} />
                </Field>
                <SubmitButton variant="secondary" pendingLabel="Saving…">Save settings</SubmitButton>
              </form>
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Pay rules" />
            <CardBody className="text-sm">
              <p>{active.length} active · {drafts.length} draft</p>
              <Link href="/payroll/rules" className="mt-2 inline-block font-semibold text-brand-fg hover:underline">Manage pay rules</Link>
            </CardBody>
          </Card>
        </div>
      </div>
    </>
  );
}
