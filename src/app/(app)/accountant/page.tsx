import Link from "next/link";
import { Banknote, FileText, Hourglass, Receipt } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { StatTile } from "@/components/ui/stat-tile";
import { EmptyState, Notice } from "@/components/ui/states";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { defaultYear } from "@/lib/accounting/year";
import { formatDate, formatDateTime } from "@/lib/dates";
import { formatCents } from "@/lib/money";
import { requirePagePermission } from "@/server/auth";
import { accountantMe, loadAccountingYear, recordAccountantVisit } from "@/server/data/accountant-view";
import { businessToday } from "@/server/data/settings";

export const metadata = { title: "Accountant view" };

const fmt = (n: number, d = 0) => n.toLocaleString("en-US", { maximumFractionDigits: d });

/**
 * Accountant view (B134, owner 2026-11-02): a year of the company's financial records for its outside accountant —
 * invoices, payments, what is still owed, hauler settlements, fuel and IFTA by quarter, and payroll when the owner's
 * invite includes it. Read-only for everyone; owners see exactly what their accountant sees. Each visit is recorded.
 */
export default async function AccountantPage({ searchParams }: { searchParams: Promise<{ year?: string }> }) {
  const access = await requirePagePermission("accounting.view");
  const { today, timezone } = await businessToday();
  const sp = await searchParams;
  const y = Number(sp.year);
  const thisYear = Number(today.slice(0, 4));
  const year = Number.isInteger(y) && y >= 2000 && y <= thisYear ? y : defaultYear(today);
  const me = await accountantMe();
  const [data] = await Promise.all([loadAccountingYear(year, today, Boolean(me?.payroll)), recordAccountantVisit(`year ${year}`).catch(() => undefined)]);
  const s = data.summary;
  const isAccountant = access.role === "accountant";

  return (
    <>
      <PageHeader
        title="Accountant view"
        description={isAccountant
          ? `Read-only financial records of ${access.companyName ?? "the company"}. Nothing here can be changed.`
          : "What your outside accountant sees: read-only financial records for the year. Give, extend or end their access in Settings → Accountant access."}
      />
      {isAccountant && me?.ends_at && (
        <Notice title={`Your access ends ${formatDateTime(me.ends_at, timezone)}`}>The owner can extend it. Every visit is recorded for the owner.</Notice>
      )}
      <div className="mt-4 mb-5 flex flex-wrap items-center gap-2" aria-label="Year">
        <ButtonLink href={`/accountant?year=${year - 1}`} variant="secondary" size="sm">{year - 1}</ButtonLink>
        <span className="px-2 text-lg font-semibold text-ink">{year}</span>
        {year < thisYear && <ButtonLink href={`/accountant?year=${year + 1}`} variant="secondary" size="sm">{year + 1}</ButtonLink>}
      </div>

      {!data.invoicesInstalled ? <Notice title="Not available yet">Invoices need a database update that has not been installed yet.</Notice> : (
        <>
          <div className="mb-5 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile icon={<FileText />} label={`Invoiced in ${year}`} value={formatCents(s.invoicedCents)} muted={!s.invoicedCents}>{s.issued.length} invoice{s.issued.length === 1 ? "" : "s"} issued</StatTile>
            <StatTile icon={<Receipt />} label="Sales tax invoiced" value={formatCents(s.taxCents)} muted={!s.taxCents}>On those invoices</StatTile>
            <StatTile icon={<Banknote />} label={`Received in ${year}`} value={formatCents(s.receivedCents)} muted={!s.receivedCents}>{s.payments.length} payment{s.payments.length === 1 ? "" : "s"}</StatTile>
            <StatTile icon={<Hourglass />} label="Still owed today" value={formatCents(s.outstandingCents)} muted={!s.outstandingCents}>All open invoices, any year</StatTile>
          </div>

          <div className="mb-5 grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <Card>
              <CardHeader title={`Invoices issued in ${year}`} description="Void invoices are left out. Paid and open amounts are as of today." />
              <div className="flex flex-wrap gap-4 px-5 pb-3 text-sm sm:px-6">
                <a href={`/accountant/export?kind=invoices&year=${year}`} className="font-semibold text-brand-fg hover:underline">Download invoices (CSV)</a>
                <a href={`/accountant/export?kind=payments&year=${year}`} className="font-semibold text-brand-fg hover:underline">Download payments (CSV)</a>
              </div>
              {s.issued.length === 0 ? <CardBody><EmptyState title={`No invoices issued in ${year}`} /></CardBody> : (
                <TableWrap className="max-h-[28rem] overflow-y-auto rounded-none border-0 border-t border-line">
                  <Table aria-label="Invoices issued">
                    <thead><tr><Th>Invoice</Th><Th>Issued</Th><Th>Customer</Th><Th align="right">Total</Th><Th>Status</Th></tr></thead>
                    <tbody>
                      {s.issued.map((i) => (
                        <Tr key={i.id}>
                          <Td className="font-semibold">{i.number ?? "–"}</Td>
                          <Td>{i.issue_date ? formatDate(i.issue_date) : "–"}</Td>
                          <Td>{i.customer_name}</Td>
                          <Td align="right" className="tabular">{formatCents(i.total_cents)}</Td>
                          <Td><Badge tone={i.status === "paid" ? "green" : "gray"}>{i.status.replace(/_/g, " ")}</Badge></Td>
                        </Tr>
                      ))}
                    </tbody>
                  </Table>
                </TableWrap>
              )}
            </Card>
            <Card>
              <CardHeader title="Still owed, by age" description="Open balances today, by days past the due date." />
              <ul className="divide-y divide-line border-t border-line" aria-label="Receivables aging">
                {s.aging.map((a) => (
                  <li key={a.label} className="flex items-center justify-between px-5 py-2.5 text-sm sm:px-6">
                    <span>{a.label} <span className="text-muted">({a.count})</span></span>
                    <span className="font-semibold tabular">{formatCents(a.cents)}</span>
                  </li>
                ))}
              </ul>
            </Card>
          </div>
        </>
      )}

      <div className="mb-5 grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader title={`Fuel and IFTA · ${year}`} description="Miles from drivers' trip sheets and gallons from fuel receipts, per quarter. Download each quarter's IFTA summary for the return." />
          <ul className="divide-y divide-line border-t border-line" aria-label="IFTA quarters">
            {data.quarters.map((q) => (
              <li key={q.quarter} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-2.5 text-sm sm:px-6">
                <span className="w-10 font-semibold">Q{q.quarter}</span>
                <span className="min-w-0 flex-1 text-muted tabular">
                  {q.future ? "Not started" : !q.installed ? "Not available yet" : `${fmt(q.miles)} mi · ${fmt(q.gallons, 1)} gal${q.mpg !== null ? ` · ${fmt(q.mpg, 2)} MPG` : ""}`}
                </span>
                {!q.future && q.installed && <a href={`/fleet/fuel/ifta.csv?q=${year}-${q.quarter}`} className="font-semibold text-brand-fg hover:underline">IFTA CSV</a>}
              </li>
            ))}
          </ul>
        </Card>
        <Card>
          <CardHeader title={`Hauler settlements · ${year}`} description="What hired haulers were owed for their jobs, after commission and deductions." />
          {data.settlements === null ? <CardBody><p className="text-sm text-muted">Not available.</p></CardBody> : data.settlements.length === 0 ? <CardBody><EmptyState title="No settlements this year" /></CardBody> : (
            <ul className="divide-y divide-line border-t border-line" aria-label="Hauler settlements">
              {data.settlements.map((h) => (
                <li key={h.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-2.5 text-sm sm:px-6">
                  <span className="font-semibold">{h.number}</span>
                  <span className="min-w-0 flex-1 text-muted">{h.haulers?.name ?? "Hauler"} · {formatDate(h.period_start)}–{formatDate(h.period_end)}</span>
                  <span className="tabular">{formatCents(h.net_cents)}</span>
                  <Badge tone={h.status === "paid" ? "green" : "gray"}>{h.paid_on ? `Paid ${formatDate(h.paid_on)}` : h.status}</Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {me?.payroll && (
        <Card className="mb-5">
          <CardHeader title={`Driver payroll · ${year}`} description="Approved pay periods only: gross pay per driver from verified tickets and adjustments. Taxes and deductions are your payroll provider's." />
          {!data.payroll ? <CardBody><p className="text-sm text-muted">Not available.</p></CardBody> : data.payroll.length === 0 ? <CardBody><EmptyState title="No approved pay periods this year" /></CardBody> : (
            <ul className="divide-y divide-line border-t border-line" aria-label="Pay periods">
              {data.payroll.map((p) => (
                <li key={p.id} className="px-5 py-3 text-sm sm:px-6">
                  <p className="font-semibold">{formatDate(p.starts_on)} – {formatDate(p.ends_on)} <span className="font-normal text-muted">· {formatCents(p.drivers.reduce((n, d) => n + d.gross_cents, 0))} gross</span></p>
                  <p className="mt-1 text-muted">{p.drivers.map((d) => `${d.name} ${formatCents(d.gross_cents)}`).join(" · ") || "No drivers paid"}</p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
      <p className="text-xs text-muted">Figures come straight from the company&apos;s records in Taviron; nothing here is estimated. {isAccountant ? "" : <Link href="/settings?tab=accountants" className="underline">Manage accountant access</Link>}</p>
    </>
  );
}
