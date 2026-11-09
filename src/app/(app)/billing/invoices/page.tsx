import Link from "next/link";
import { AlarmClock, CircleDollarSign, FileText, Wallet } from "lucide-react";
import { AdminFlash } from "@/components/admin/flash";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { StatTile } from "@/components/ui/stat-tile";
import { EmptyState, Notice } from "@/components/ui/states";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { AGING_BUCKETS, AGING_LABEL, STATE_LABEL, balanceCents, ordersWord, daysBetween, invoiceState, receivablesAging, type InvoiceState } from "@/lib/billing/invoices";
import { cn } from "@/lib/cn";
import { formatDate, todayIn } from "@/lib/dates";
import { formatCents } from "@/lib/money";
import { can } from "@/lib/permissions";
import { requirePagePermission } from "@/server/auth";
import { invoicingSettings, listInvoices } from "@/server/data/invoices";
import { businessToday } from "@/server/data/settings";

export const metadata = { title: "Invoices" };

const VIEWS: Array<{ key: "all" | InvoiceState; label: string }> = [
  { key: "all", label: "All" }, { key: "draft", label: "Drafts" }, { key: "open", label: "Open" }, { key: "overdue", label: "Overdue" },
  { key: "partly_paid", label: "Partly paid" }, { key: "paid", label: "Paid" }, { key: "void", label: "Void" },
];
const dollars = (c: number) => formatCents(c).replace(/\.\d\d$/, "");

/**
 * Invoices and receivables (B99, migration 20261120004800): what each customer owes and how late, and every invoice
 * Taviron issued. Companies whose invoices QuickBooks issues see where to change that.
 */
export default async function InvoicesPage({ searchParams }: { searchParams: Promise<{ view?: string; error?: string; saved?: string }> }) {
  const access = await requirePagePermission("billing.view");
  const sp = await searchParams;
  const [invoices, settings, { today, timezone }] = await Promise.all([listInvoices(), invoicingSettings(), businessToday()]);
  const view = VIEWS.some((v) => v.key === sp.view) ? (sp.view as "all" | InvoiceState) : "all";
  const header = (
    <PageHeader
      title="Invoices"
      description="Invoices Taviron issued from handed-off orders, what is paid, and what each customer still owes. Nothing here charges a card or posts to an accounting system."
      actions={<>
        <ButtonLink href="/billing/invoices/combine" variant="ghost">One invoice for several orders</ButtonLink>
        <ButtonLink href="/billing?view=handed_off" variant="secondary">Handed-off orders</ButtonLink>
      </>}
    />
  );
  if (!invoices || !settings.installed) {
    return <>{header}<Notice title="Not available yet">Invoicing needs a database update that has not been installed yet.</Notice></>;
  }
  const states = invoices.map((i) => ({ i, state: invoiceState(i, today) }));
  const aging = receivablesAging(invoices, today);
  const overdue = states.filter((x) => x.state === "overdue");
  const dueSoon = states.filter((x) => (x.state === "open" || x.state === "partly_paid") && x.i.due_date && daysBetween(today, x.i.due_date) <= 7);
  const paid30 = invoices.flatMap((i) => i.payments).filter((p) => !p.voided_at && daysBetween(p.received_on, today) <= 30).reduce((n, p) => n + p.amount_cents, 0);
  const shown = view === "all" ? states : states.filter((x) => x.state === view);
  const count = (k: "all" | InvoiceState) => (k === "all" ? states.length : states.filter((x) => x.state === k).length);

  return (
    <>
      {header}
      <AdminFlash error={sp.error} />
      {settings.issuer === "quickbooks" && (
        <div className="mb-5">
          <Notice title="QuickBooks issues your invoices">
            Handed-off orders are sent to QuickBooks from Billing. To issue invoices from Taviron instead, with your own logo and colour,
            {can(access, "billing.manage") ? <> change it in <Link href="/settings?tab=invoicing" className="font-semibold underline">Settings → Invoicing</Link>.</> : " ask someone who manages billing."}
          </Notice>
        </div>
      )}
      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="Receivables at a glance">
        <StatTile icon={<Wallet />} tone="brand" label="Owed to you" value={dollars(aging.totals.total)} muted={aging.totals.total === 0}>
          <span className="text-muted">{aging.rows.length} customer{aging.rows.length === 1 ? "" : "s"}</span>
        </StatTile>
        <StatTile icon={<AlarmClock />} tone={overdue.length ? "critical" : "neutral"} label="Overdue" value={dollars(overdue.reduce((n, x) => n + balanceCents(x.i), 0))} muted={!overdue.length}>
          {overdue.length ? <Link href="/billing/invoices?view=overdue" className="font-semibold text-critical underline-offset-2 hover:underline">{overdue.length} invoice{overdue.length === 1 ? "" : "s"} past due</Link> : <span className="text-muted">nothing past due</span>}
        </StatTile>
        <StatTile icon={<FileText />} tone={dueSoon.length ? "amber" : "neutral"} label="Due in 7 days" value={dollars(dueSoon.reduce((n, x) => n + balanceCents(x.i), 0))} muted={!dueSoon.length}>
          <span className="text-muted">{dueSoon.length} invoice{dueSoon.length === 1 ? "" : "s"}</span>
        </StatTile>
        <StatTile icon={<CircleDollarSign />} tone="green" label="Paid, last 30 days" value={dollars(paid30)} muted={paid30 === 0}>
          <span className="text-muted">payments recorded</span>
        </StatTile>
      </div>

      {aging.rows.length > 0 && (
        <Card className="mb-5">
          <CardHeader title="Receivables by age" description="What each customer still owes on issued invoices, by how many days past the due date." />
          <TableWrap>
            <Table aria-label="Receivables by age">
              <thead>
                <tr><Th>Customer</Th>{AGING_BUCKETS.map((b) => <Th key={b} align="right" className={b === "current" ? "" : "hidden md:table-cell"}>{AGING_LABEL[b]}</Th>)}<Th align="right">Total</Th></tr>
              </thead>
              <tbody>
                {aging.rows.map((r) => (
                  <Tr key={r.customer_id}>
                    <Td><Link href={`/customers/${r.customer_id}`} className="font-medium hover:underline">{r.customer_name}</Link></Td>
                    {AGING_BUCKETS.map((b) => (
                      <Td key={b} align="right" className={cn("tabular", b !== "current" && "hidden md:table-cell", r.buckets[b] && b !== "current" ? "font-semibold text-critical" : !r.buckets[b] && "text-muted/60")}>{r.buckets[b] ? formatCents(r.buckets[b]) : "–"}</Td>
                    ))}
                    <Td align="right" className="font-semibold tabular">{formatCents(r.total)}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </TableWrap>
        </Card>
      )}

      <Card>
        <nav aria-label="Invoice status" className="flex flex-wrap gap-2 border-b border-line/70 px-5 py-3 sm:px-6">
          {VIEWS.map((v) => (
            <Link key={v.key} href={v.key === "all" ? "/billing/invoices" : `/billing/invoices?view=${v.key}`} aria-current={view === v.key ? "page" : undefined}
              className={cn("inline-flex h-[30px] items-center gap-1.5 rounded-full border px-3 text-[13px] font-medium", view === v.key ? "border-strong bg-strong text-white" : "border-line bg-card text-ink hover:border-strong/30")}>
              <span className="pill-text">{v.label}</span>
              <Badge tone={view === v.key ? "dark" : "gray"}>{count(v.key)}</Badge>
            </Link>
          ))}
        </nav>
        {shown.length === 0 ? (
          <EmptyState title={invoices.length ? "No invoices in this view" : "No invoices yet"} description={settings.issuer === "taviron" ? "Create an invoice from a handed-off order under Billing → Handed off." : "Invoices appear here once Taviron issues them."} />
        ) : (
          <TableWrap>
            <Table aria-label="Invoices">
              <thead>
                <tr><Th>Invoice</Th><Th>Customer</Th><Th className="hidden md:table-cell">Issued</Th><Th className="hidden sm:table-cell">Due</Th><Th align="right">Total</Th><Th align="right">Balance</Th><Th>Status</Th></tr>
              </thead>
              <tbody>
                {shown.map(({ i, state }) => (
                  <Tr key={i.id}>
                    <Td>
                      <Link href={`/billing/invoices/${i.id}`} className="font-semibold tabular text-brand-fg hover:underline">{i.number ?? "Draft"}</Link>
                      <div className="text-xs text-muted">{ordersWord(i.order_number, true)} {i.order_number}</div>
                    </Td>
                    <Td className="text-sm">{i.customer_name}</Td>
                    <Td className="hidden text-sm tabular md:table-cell">{i.issue_date ? formatDate(i.issue_date) : "–"}</Td>
                    <Td className={cn("hidden text-sm tabular sm:table-cell", state === "overdue" && "font-semibold text-critical")}>{i.due_date ? formatDate(i.due_date) : "–"}</Td>
                    <Td align="right" className="tabular">{formatCents(i.total_cents)}</Td>
                    <Td align="right" className="font-semibold tabular">{i.status === "issued" ? formatCents(balanceCents(i)) : "–"}</Td>
                    <Td>
                      <Badge tone={STATE_LABEL[state].tone}>{STATE_LABEL[state].label}</Badge>
                      {i.status === "issued" && <div className={cn("mt-1 text-xs", i.sent_at ? "text-muted" : "font-semibold text-ink")}>{i.sent_at ? `Sent ${formatDate(todayIn(timezone, new Date(i.sent_at)))}` : "Not sent yet"}</div>}
                    </Td>
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
