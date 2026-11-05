import Link from "next/link";
import { redirect } from "next/navigation";
import { CalendarClock, TrendingDown, Wallet } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { StatTile } from "@/components/ui/stat-tile";
import { EmptyState } from "@/components/ui/states";
import { balanceCents, paidCents } from "@/lib/billing/invoices";
import { cn } from "@/lib/cn";
import { addDays, formatDate } from "@/lib/dates";
import { cashForecast, orderingLess, payingSlower, type OpenInvoice, type OrderPoint, type PaidInvoice } from "@/lib/insights/customers";
import { formatCents } from "@/lib/money";
import { can } from "@/lib/permissions";
import { requireAccess } from "@/server/auth";
import { listInvoices } from "@/server/data/invoices";
import { businessToday } from "@/server/data/settings";
import { createClient } from "@/server/supabase/server";

export const metadata = { title: "Customer insights" };

/**
 * Customer health and cash forecast (B118, B119): customers ordering less than usual or paying slower, and the money
 * expected over the next 4 weeks from open invoices and each customer's own payment habits. Estimates are labelled;
 * nothing is sent or changed.
 */
export default async function CustomerInsightsPage() {
  const access = await requireAccess();
  const orders = can(access, "orders.view");
  const billing = can(access, "billing.view");
  if (!orders && !billing) redirect("/reports");
  const { today } = await businessToday();
  const supabase = await createClient();
  const [orderRows, invoices] = await Promise.all([
    orders
      ? supabase.from("orders").select("customer_id, order_date, total_cents, customers(name)").not("status", "in", "(draft,canceled)").gte("order_date", addDays(today, -119)).limit(10000)
        .then((r) => (r.error ? [] : ((r.data ?? []) as unknown as Array<{ customer_id: string; order_date: string; total_cents: number | string; customers: { name: string } | null }>)))
      : Promise.resolve([]),
    billing ? listInvoices().catch(() => null) : Promise.resolve(null),
  ]);
  // Most profitable customers (owner 2026-11-02): profit per customer over the last 90 days (B104 cost rates).
  const profit = billing
    ? await supabase.rpc("report_profit", { p_from: addDays(today, -90), p_to: addDays(today, -1) })
        .then((r) => (r.error ? null : (r.data as { has_rates: boolean; by_customer: Array<{ name: string; loads: number; revenue_cents: number; cost_cents: number; profit_cents: number }> })))
    : null;
  const topProfit = (profit?.by_customer ?? []).filter((c) => c.revenue_cents > 0).sort((a, b) => b.profit_cents - a.profit_cents).slice(0, 10);
  const points: OrderPoint[] = orderRows.map((o) => ({ customerId: o.customer_id, customerName: o.customers?.name ?? "Customer", orderDate: o.order_date, totalCents: Number(o.total_cents) }));
  const issued = (invoices ?? []).filter((i) => i.status === "issued" && i.issue_date);
  const paid: PaidInvoice[] = issued
    .filter((i) => i.total_cents > 0 && paidCents(i) >= i.total_cents)
    .map((i) => ({ customerId: i.customer_id, issueDate: i.issue_date!, paidDate: i.payments.filter((p) => !p.voided_at).map((p) => p.received_on).sort().at(-1)! }));
  const open: OpenInvoice[] = issued.filter((i) => balanceCents(i) > 0)
    .map((i) => ({ id: i.id, number: i.number, customerId: i.customer_id, customerName: i.customer_name, issueDate: i.issue_date!, dueDate: i.due_date, balanceCents: balanceCents(i) }));

  const less = orders ? orderingLess(points, today) : [];
  const slower = billing ? payingSlower(paid, open) : [];
  const forecast = billing && invoices ? cashForecast(open, paid, today) : null;
  const next4 = forecast ? forecast.weeks.reduce((n, w) => n + w.cents, 0) : 0;
  const maxWeek = forecast ? Math.max(1, ...forecast.weeks.map((w) => w.cents), forecast.late.cents) : 1;

  return (
    <>
      <PageHeader
        title="Customer insights"
        description="Your most profitable customers, those ordering less than usual or paying slower, and the money you can expect over the next four weeks, from your own orders, invoices and payments. Estimates are labelled; nothing is sent."
        actions={<ButtonLink href="/reports" variant="secondary">Reports</ButtonLink>}
      />
      <div className="mb-5 grid grid-cols-1 gap-4 sm:grid-cols-3">
        {orders && <StatTile icon={<TrendingDown />} tone={less.length ? "amber" : "green"} label="Ordering less than usual" value={less.length} muted={!less.length}>Under half their usual month</StatTile>}
        {billing && <StatTile icon={<CalendarClock />} tone={slower.length ? "amber" : "green"} label="Paying slower" value={slower.length} muted={!slower.length}>10+ days slower than before</StatTile>}
        {forecast && <StatTile icon={<Wallet />} label="Expected next 4 weeks" value={formatCents(next4)} muted={!next4}>Estimate · plus {formatCents(forecast.late.cents)} already late</StatTile>}
      </div>

      {forecast && (
        <Card className="mb-5">
          <CardHeader title="Cash forecast" description="Each open invoice placed on the date the customer usually pays (their last payments), or its due date when they have no history yet." />
          <CardBody>
            <ul className="space-y-2.5" aria-label="Cash forecast">
              {[{ label: "Already late", cents: forecast.late.cents, invoices: forecast.late.invoices, late: true }, ...forecast.weeks.map((w, i) => ({ label: i === 0 ? `This week (${formatDate(w.from)} – ${formatDate(w.to)})` : `${formatDate(w.from)} – ${formatDate(w.to)}`, cents: w.cents, invoices: w.invoices, late: false }))].map((r) => (
                <li key={r.label} className="grid grid-cols-[minmax(0,12rem)_1fr_auto] items-center gap-3 text-sm">
                  <span className={cn("truncate", r.late ? "font-medium text-amber-800" : "text-muted")}>{r.label}</span>
                  <span className="h-2.5 overflow-hidden rounded-full bg-ink/[0.06]"><span className={cn("block h-full rounded-full", r.late ? "bg-amber-500" : "bg-brand")} style={{ width: `${Math.round((r.cents / maxWeek) * 100)}%` }} /></span>
                  <span className="w-32 text-right font-semibold tabular">{formatCents(r.cents)} <span className="font-normal text-muted">· {r.invoices}</span></span>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-muted">
              {forecast.estimatedFromHistory} invoice{forecast.estimatedFromHistory === 1 ? "" : "s"} placed from payment history, {forecast.fromTerms} from terms{forecast.unknown ? `, ${forecast.unknown} without a date` : ""}. {forecast.beyond.invoices ? `${formatCents(forecast.beyond.cents)} expected after four weeks.` : ""}
            </p>
          </CardBody>
        </Card>
      )}

      {billing && profit && (
        <Card className="mb-5">
          <CardHeader
            title="Most profitable customers"
            description={profit.has_rates ? "Last 90 days: revenue from delivered tickets minus your cost rates on each load's hours. An estimate." : "Last 90 days by revenue. Add cost rates (Settings → Cost rates) to rank by profit."}
          />
          {topProfit.length === 0 ? <CardBody><EmptyState title="No priced deliveries in the last 90 days" /></CardBody> : (
            <ol className="divide-y divide-line border-t border-line" aria-label="Most profitable customers">
              {(profit.has_rates ? topProfit : [...topProfit].sort((a, b) => b.revenue_cents - a.revenue_cents)).map((c, i) => (
                <li key={c.name} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3 text-sm sm:px-6">
                  <span className="w-5 text-right text-muted tabular">{i + 1}</span>
                  <Link href={`/customers?q=${encodeURIComponent(c.name)}`} className="min-w-0 flex-1 font-semibold hover:underline">{c.name}</Link>
                  <span className="text-muted tabular">{c.loads} loads · {formatCents(c.revenue_cents)} revenue</span>
                  {profit.has_rates && (
                    <span className="w-40 text-right">
                      <span className={cn("font-semibold tabular", c.profit_cents < 0 ? "text-critical" : "text-ink")}>{formatCents(c.profit_cents)}</span>
                      <span className="text-muted"> · {c.revenue_cents > 0 ? `${Math.round((c.profit_cents / c.revenue_cents) * 100)}%` : "–"}</span>
                    </span>
                  )}
                </li>
              ))}
            </ol>
          )}
        </Card>
      )}

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        {orders && (
          <Card>
            <CardHeader title="Ordering less than usual" description="Last 30 days against their average month over the 3 months before. Customers who order at least twice a month." />
            {less.length === 0 ? <CardBody><EmptyState title="Every regular customer is ordering as usual" /></CardBody> : (
              <ul className="divide-y divide-line border-t border-line" aria-label="Ordering less than usual">
                {less.map((c) => (
                  <li key={c.customerId} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3 sm:px-6">
                    <Link href={`/customers/${c.customerId}`} className="font-semibold hover:underline">{c.customerName}</Link>
                    <span className="min-w-0 flex-1 text-sm text-muted">{c.detail}</span>
                    {c.weightCents > 0 && <Badge tone="amber">≈ {formatCents(c.weightCents)} below usual</Badge>}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}
        {billing && (
          <Card>
            <CardHeader title="Paying slower" description="Their last 2 paid invoices took 10+ days longer than the 4 before." />
            {slower.length === 0 ? <CardBody><EmptyState title={paid.length ? "No customer is paying slower" : "Not enough payment history yet"} /></CardBody> : (
              <ul className="divide-y divide-line border-t border-line" aria-label="Paying slower">
                {slower.map((c) => (
                  <li key={c.customerId} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3 sm:px-6">
                    <Link href={`/customers/${c.customerId}`} className="font-semibold hover:underline">{c.customerName || "Customer"}</Link>
                    <span className="min-w-0 flex-1 text-sm text-muted">{c.detail}</span>
                    {c.weightCents > 0 && <Badge tone="amber">{formatCents(c.weightCents)} open</Badge>}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}
      </div>
    </>
  );
}
