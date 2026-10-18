import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { FlashToast } from "@/components/ui/flash-toast";
import { Checkbox, Field, Input, Select } from "@/components/ui/form";
import { PageHeader } from "@/components/ui/page-header";
import { Notice } from "@/components/ui/states";
import { SubmitButton } from "@/components/ui/submit-button";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { formatDate, formatDateTime } from "@/lib/dates";
import { centsText } from "@/lib/payroll/export";
import { PERIOD_STATUS } from "@/lib/payroll/labels";
import { requirePagePermission } from "@/server/auth";
import { loadPayrollHome, loadPeriod } from "@/server/data/payroll";
import { addAdjustment, approvePeriod, calculate, recordExportOutcome, setEntry } from "../../actions";

export const metadata = { title: "Payroll period" };

const money = (cents: number) => `${cents < 0 ? "−" : ""}$${centsText(Math.abs(cents))}`;
const NOT_PAYABLE: Record<string, string> = { no_driver: "No driver on the ticket", not_verified: "Not verified yet (waiting for office review)" };

/** One payroll period: driver totals traced to tickets, exceptions to resolve, approval and export. */
export default async function PayrollPeriodPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string; n?: string }> }) {
  await requirePagePermission("payroll.manage");
  const { id } = await params;
  const sp = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const [p, home] = await Promise.all([loadPeriod(id), loadPayrollHome()]);
  if (!p) notFound();
  const { period, entries, adjustments, exports, work, drivers, ruleNames } = p;
  const open = period.status === "open" || period.status === "in_review";
  const name = (d: string | null) => (d ? drivers.get(d)?.name ?? "Driver" : "No driver");
  const live = entries.filter((e) => e.status === "calculated");
  const exceptions = entries.filter((e) => e.status === "exception");
  const byDriver = new Map<string, { tickets: number; tons: number; earnings: number; adjustments: number }>();
  const row = (d: string) => byDriver.get(d) ?? (byDriver.set(d, { tickets: 0, tons: 0, earnings: 0, adjustments: 0 }), byDriver.get(d)!);
  for (const e of live) {
    const r = row(e.driver_id);
    r.tickets++;
    r.earnings += e.amount_cents ?? 0;
    if (e.delivery_tickets?.unit_code === "ton") r.tons += Number(e.delivery_tickets.quantity);
  }
  for (const a of adjustments) row(a.driver_id).adjustments += a.amount_cents;
  const total = [...byDriver.values()].reduce((n, r) => n + r.earnings + r.adjustments, 0);
  const enabled = home?.settings.enabled ?? false;
  return (
    <>
      <FlashToast messages={{ saved: { text: sp.n !== undefined ? `${sp.n} ticket${sp.n === "1" ? "" : "s"} added to the period.` : "Saved." } }} />
      <PageHeader
        title={`Payroll ${formatDate(period.starts_on)} – ${formatDate(period.ends_on)}`}
        description="Gross earnings from verified delivery tickets. Every amount links to its ticket and calculation."
        crumbs={[{ label: "Payroll", href: "/payroll" }, { label: `${formatDate(period.starts_on)} – ${formatDate(period.ends_on)}` }]}
        badges={<Badge tone={PERIOD_STATUS[period.status]?.tone ?? "gray"}>{PERIOD_STATUS[period.status]?.label ?? period.status}</Badge>}
      />
      {sp.error && <div className="mb-4"><Notice tone="warning" title="Not done">{sp.error}</Notice></div>}

      <section aria-label="Readiness" className="mb-5 flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg border border-line bg-card px-4 py-3 text-sm shadow-xs sm:px-5">
        <span><strong className="tabular">{work.payable.length}</strong> verified ticket{work.payable.length === 1 ? "" : "s"} not yet calculated</span>
        <span className={exceptions.length ? "font-semibold text-amber-800" : ""}><strong className="tabular">{exceptions.length}</strong> exception{exceptions.length === 1 ? "" : "s"} to resolve</span>
        <span><strong className="tabular">{work.not_payable.length}</strong> ticket{work.not_payable.length === 1 ? "" : "s"} not payable yet</span>
        {work.corrections.length > 0 && <span className="font-semibold text-amber-800">{work.corrections.length} correction{work.corrections.length === 1 ? "" : "s"} from approved periods</span>}
        <span className="ml-auto text-base font-semibold">Total {money(period.totals?.total_cents ?? total)}{period.totals ? " (approved)" : ""}</span>
      </section>

      {open && (
        <div className="mb-5 flex flex-wrap gap-3">
          {enabled ? (
            <form action={calculate}><input type="hidden" name="period" value={period.id} /><SubmitButton pendingLabel="Calculating…" disabled={!work.payable.length}>Calculate {work.payable.length} ticket{work.payable.length === 1 ? "" : "s"}</SubmitButton></form>
          ) : (
            <Notice title="Calculation is off">Turn it on in <Link href="/payroll" className="underline">Payroll settings</Link> after a pay rule is active.</Notice>
          )}
        </div>
      )}

      <Card className="mb-5">
        <CardHeader title="Earnings by driver" />
        {byDriver.size === 0 ? (
          <p className="px-4 py-5 text-sm text-muted sm:px-5">Nothing calculated in this period yet.</p>
        ) : (
          <TableWrap className="rounded-none border-0">
            <Table>
              <thead><tr><Th>Driver</Th><Th align="right">Tickets</Th><Th align="right">Tons</Th><Th align="right">Ticket earnings</Th><Th align="right">Adjustments</Th><Th align="right">Gross</Th></tr></thead>
              <tbody>
                {[...byDriver].map(([d, r]) => (
                  <Tr key={d}>
                    <Td><a href={`#driver-${d}`} className="font-semibold hover:underline">{name(d)}</a></Td>
                    <Td align="right">{r.tickets}</Td>
                    <Td align="right" className="tabular">{r.tons ? r.tons.toFixed(2) : "—"}</Td>
                    <Td align="right" className="tabular">{money(r.earnings)}</Td>
                    <Td align="right" className="tabular">{r.adjustments ? money(r.adjustments) : "—"}</Td>
                    <Td align="right" className="tabular font-semibold">{money(r.earnings + r.adjustments)}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </TableWrap>
        )}
      </Card>

      {exceptions.length > 0 && (
        <Card className="mb-5">
          <CardHeader title="Exceptions" description="Tickets Taviron could not calculate. Fix the cause (rule, ticket) and reverse the exception to recalculate, or exclude it with a reason." />
          <ul className="divide-y divide-line">
            {exceptions.map((e) => (
              <li key={e.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm sm:px-5">
                <span className="min-w-0 flex-[1_1_16rem]"><Link href={`/tickets/${e.ticket_id}`} className="font-semibold hover:underline">{e.delivery_tickets?.ticket_number}</Link> · {name(e.driver_id)} — <span className="text-amber-800">{e.exception}</span></span>
                {open && (
                  <form action={setEntry} className="flex flex-wrap items-center gap-2">
                    <input type="hidden" name="period" value={period.id} /><input type="hidden" name="id" value={e.id} />
                    <Input name="note" required minLength={3} placeholder="Reason" aria-label="Reason" className="w-48" />
                    <Select name="status" aria-label="Action" defaultValue="reversed"><option value="reversed">Recalculate later</option><option value="excluded">Exclude from pay</option></Select>
                    <SubmitButton size="sm" variant="secondary" pendingLabel="Saving…">Apply</SubmitButton>
                  </form>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {(work.not_payable.length > 0 || work.corrections.length > 0) && (
        <Card className="mb-5">
          <CardHeader title="Not payable yet, and corrections" />
          <ul className="divide-y divide-line text-sm">
            {work.not_payable.map((t) => (
              <li key={t.ticket_id} className="px-4 py-2.5 sm:px-5"><Link href={`/tickets/${t.ticket_id}`} className="font-semibold hover:underline">{t.ticket_number}</Link> · {name(t.driver_id)} — {NOT_PAYABLE[t.reason]}</li>
            ))}
            {work.corrections.map((c) => (
              <li key={c.entry_id} className="px-4 py-2.5 sm:px-5">
                <Link href={`/tickets/${c.ticket_id}`} className="font-semibold hover:underline">{c.ticket_number}</Link> · {name(c.driver_id)} — paid {money(c.amount_cents)} in the period starting {formatDate(c.paid_in)}, then {c.ticket_status === "voided" ? "voided" : "corrected"}. Settle it with an adjustment below (link it to this ticket).
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card className="mb-5">
        <CardHeader title="Tickets in this period" />
        {entries.length === 0 ? (
          <p className="px-4 py-5 text-sm text-muted sm:px-5">No tickets recorded yet.</p>
        ) : (
          <TableWrap className="rounded-none border-0">
            <Table>
              <thead><tr><Th>Ticket</Th><Th>Driver</Th><Th>Delivered</Th><Th align="right">Quantity</Th><Th>Rule and calculation</Th><Th align="right">Amount</Th></tr></thead>
              <tbody>
                {entries.map((e) => (
                  <Tr key={e.id} id={`driver-${e.driver_id}`}>
                    <Td><Link href={`/tickets/${e.ticket_id}`} className="font-semibold hover:underline">{e.delivery_tickets?.ticket_number}</Link>{e.status !== "calculated" && <Badge className="ml-2" tone={e.status === "exception" ? "amber" : "gray"}>{e.status}</Badge>}</Td>
                    <Td>{name(e.driver_id)}</Td>
                    <Td className="whitespace-nowrap">{e.delivery_tickets ? formatDate(e.delivery_tickets.delivered_at.slice(0, 10)) : ""}</Td>
                    <Td align="right" className="tabular">{e.delivery_tickets ? `${e.delivery_tickets.quantity} ${e.delivery_tickets.unit_code}` : ""}</Td>
                    <Td className="text-xs">{e.rule_version_id ? <span className="font-semibold">{ruleNames.get(e.rule_version_id)}</span> : null}<span className="block text-muted">{e.breakdown || e.exception || e.note}</span></Td>
                    <Td align="right" className="tabular">{e.amount_cents !== null && e.status === "calculated" ? money(e.amount_cents) : "—"}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </TableWrap>
        )}
      </Card>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader title="Adjustments" description="Additions or deductions entered by a person, with a reason. Nothing is deducted automatically." />
          {adjustments.length > 0 && (
            <ul className="divide-y divide-line text-sm">
              {adjustments.map((a) => <li key={a.id} className="px-4 py-2.5 sm:px-5"><span className="font-semibold tabular">{money(a.amount_cents)}</span> · {name(a.driver_id)} — {a.reason}</li>)}
            </ul>
          )}
          {open && (
            <CardBody className="border-t border-line">
              <form action={addAdjustment} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <input type="hidden" name="period" value={period.id} />
                <Field label="Driver" htmlFor="adj-driver">
                  <Select id="adj-driver" name="driver" required defaultValue=""><option value="" disabled>Choose</option>{[...drivers.values()].map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</Select>
                </Field>
                <Field label="Amount ($, minus for a deduction)" htmlFor="adj-amount"><Input id="adj-amount" name="amount" required inputMode="decimal" placeholder="-4.25" /></Field>
                <Field label="For a corrected ticket (optional)" htmlFor="adj-entry" className="sm:col-span-2">
                  <Select id="adj-entry" name="entry" defaultValue=""><option value="">Not linked</option>{work.corrections.map((c) => <option key={c.entry_id} value={c.entry_id}>{c.ticket_number} ({name(c.driver_id)})</option>)}</Select>
                </Field>
                <Field label="Reason" htmlFor="adj-reason" className="sm:col-span-2"><Input id="adj-reason" name="reason" required minLength={3} maxLength={500} /></Field>
                <div className="sm:col-span-2"><SubmitButton variant="secondary" pendingLabel="Saving…">Add adjustment</SubmitButton></div>
              </form>
            </CardBody>
          )}
        </Card>

        <Card>
          <CardHeader title={open ? "Approve" : "Export"} description={open ? "Approving locks the period with these totals. Later changes go into a later period." : `Approved ${period.approved_at ? formatDateTime(period.approved_at) : ""}. Files are gross earnings for your bookkeeper — not a verified QuickBooks or payroll-provider import.`} />
          <CardBody className="space-y-4">
            {open ? (
              <form action={approvePeriod} className="space-y-2">
                <input type="hidden" name="period" value={period.id} />
                <Checkbox name="confirm" label={`I checked the totals (${money(total)}) against the tickets`} />
                <SubmitButton pendingLabel="Approving…" disabled={exceptions.length > 0}>Approve and lock</SubmitButton>
                {exceptions.length > 0 && <p className="text-sm text-amber-800">Resolve the {exceptions.length} exception{exceptions.length === 1 ? "" : "s"} first.</p>}
              </form>
            ) : (
              <>
                <div className="flex flex-wrap gap-2">
                  <a href={`/payroll/periods/${period.id}/export?format=summary_csv`} className={buttonClasses("secondary")}>Download summary (CSV)</a>
                  <a href={`/payroll/periods/${period.id}/export?format=detail_csv`} className={buttonClasses("secondary")}>Download ticket detail (CSV)</a>
                </div>
                {exports.length > 0 && (
                  <ul className="divide-y divide-line rounded-md border border-line text-sm">
                    {exports.map((x) => (
                      <li key={x.id} className="space-y-2 px-3 py-2">
                        <p>{x.format === "summary_csv" ? "Summary" : "Detail"} · {x.row_count} rows · {money(x.total_cents)} · {formatDateTime(x.created_at)} · <Badge tone={x.status === "accepted" ? "green" : x.status === "prepared" ? "gray" : "amber"}>{x.status}</Badge>{x.reference ? ` · ${x.reference}` : ""}</p>
                        {x.status === "prepared" && (
                          <form action={recordExportOutcome} className="flex flex-wrap items-end gap-2">
                            <input type="hidden" name="period" value={period.id} /><input type="hidden" name="id" value={x.id} />
                            <Select name="status" aria-label="Outcome" defaultValue="accepted"><option value="accepted">Accepted by payroll</option><option value="rejected">Rejected</option><option value="failed">Failed</option></Select>
                            <Input name="reference" placeholder="Reference" aria-label="Reference" className="w-32" />
                            <Input name="note" placeholder="Note" aria-label="Note" className="w-40" />
                            <SubmitButton size="sm" variant="secondary" pendingLabel="Saving…">Record</SubmitButton>
                          </form>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </CardBody>
        </Card>
      </div>
    </>
  );
}
