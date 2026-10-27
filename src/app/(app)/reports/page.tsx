import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowDownRight, ArrowUpRight, CircleDollarSign, Ticket, Timer, Truck } from "lucide-react";
import { AreaChart, Donut, Gauge, SERIES, ShareBar, Sparkline } from "@/components/reports/charts";
import { cn } from "@/lib/cn";
import { DateRangeFields } from "@/components/ui/typed-date-input";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { Notice } from "@/components/ui/states";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { addDays, formatDate, isIsoDate } from "@/lib/dates";
import { trimNumber } from "@/lib/fleet/labels";
import { formatCents } from "@/lib/money";
import { requireAccess } from "@/server/auth";
import { can } from "@/lib/permissions";
import { QuoteOutcomesSection } from "@/components/reports/quote-outcomes";
import { loadQuoteOutcomes } from "@/server/data/quote-outcomes";
import { DriverScorecardTable } from "@/components/drivers/scorecard";
import { loadScorecard } from "@/server/data/driver-scorecard";
import { businessToday } from "@/server/data/settings";
import { createClient } from "@/server/supabase/server";

import { baseSummary, listBases, type BaseSummary, type DispatchBase } from "@/server/data/bases";
export const metadata = { title: "Reports" };

interface Ranked { name: string | null; tickets: number; value_cents: number; quantity?: number; unit?: string }
interface Report {
  from: string;
  to: string;
  days: number;
  deliveries?: { tickets: number; accepted: number; pending: number; voided: number; corrected: number; median_hours_to_accept: number | null };
  value?: { verified_value_cents: number; priced_tickets: number; unpriced_tickets: number; by_customer: Ranked[]; by_line: Ranked[]; by_truck: Ranked[] };
  billing?: { handed_off_orders: number; median_days_delivery_to_handoff: number | null; ready_not_handed_off: number; ready_ordered_total_cents: number; loads_missing_tickets: number; orders_with_missing_tickets: number };
  fleet?: Array<{ unit_number: string; loads: number; days_with_loads: number; days_out_of_service: number }>;
  profitability: { available: false; missing: string[] };
}

const PERIODS = [7, 30, 90] as const;
const pct = (n: number, d: number) => (d > 0 ? `${Math.round((n / d) * 100)}%` : "—");
const compactMoney = (cents: number) => {
  const d = cents / 100;
  return d >= 1_000_000 ? `$${trimNumber(Math.round(d / 100_000) / 10)}M` : d >= 10_000 ? `$${trimNumber(Math.round(d / 100) / 10)}k` : `$${Math.round(d).toLocaleString("en-US")}`;
};

/** Change against the previous period of the same length, as a chip (owner's references 2026-10-27); honest about
 * having nothing to compare with. */
function Delta({ now, before, period }: { now: number; before: number | null; period: string }) {
  if (before === null) return <p className="mt-1.5 text-xs text-muted">No earlier period to compare</p>;
  if (before === 0) {
    return (
      <p className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-muted">
        {now > 0 && <span className="inline-flex h-[22px] items-center gap-0.5 rounded-md bg-green-50 px-1.5 font-semibold text-green-700"><ArrowUpRight className="size-3.5" aria-hidden /><span className="pill-text">New</span></span>}
        {now === 0 ? "Same as" : "none in"} the previous {period}
      </p>
    );
  }
  const change = Math.round(((now - before) / before) * 100);
  return (
    <p className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-muted">
      <span className={cn("inline-flex h-[22px] items-center gap-0.5 rounded-md px-1.5 font-semibold tabular", change > 0 ? "bg-green-50 text-green-700" : change < 0 ? "bg-amber-50 text-amber-800" : "bg-ink/[0.05] text-muted")}>
        {change > 0 ? <ArrowUpRight className="size-3.5" aria-hidden /> : change < 0 ? <ArrowDownRight className="size-3.5" aria-hidden /> : null}
        <span className="pill-text">{change > 0 ? "+" : ""}{change}%</span>
      </span>
      vs previous {period}
    </p>
  );
}

function Kpi({ icon, label, value, children, spark, sparkLabel }: { icon: ReactNode; label: string; value: string; children?: ReactNode; spark?: number[]; sparkLabel?: string }) {
  return (
    <div className="flex flex-col gap-3 rounded-panel bg-card p-5 shadow-card ring-1 ring-line/60">
      <div className="flex items-center gap-2.5 text-sm font-medium text-muted">
        <span className="grid size-8 place-items-center rounded-full bg-brand-light text-brand-fg [&_svg]:size-4">{icon}</span>
        {label}
      </div>
      <div className="flex items-end justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[1.875rem] leading-tight font-semibold tracking-[-0.03em] tabular">{value}</p>
          {children}
        </div>
        {spark && spark.some((v) => v > 0) ? <Sparkline values={spark} label={sparkLabel ?? label} className="shrink-0 text-brand-fg" /> : null}
      </div>
    </div>
  );
}

function MiniStat({ label, value, sub, attention = false }: { label: string; value: string; sub?: string; attention?: boolean }) {
  return (
    <div className="rounded-2xl bg-surface p-4">
      <p className="text-sm text-muted">{label}</p>
      <p className={cn("mt-1 text-xl font-semibold tabular", attention && "text-amber-800")}>{value}</p>
      {sub ? <p className="mt-0.5 text-xs text-muted">{sub}</p> : null}
    </div>
  );
}

/** Ranked rows with a share bar (customers, trucks). */
function RankList({ title, rows, empty }: { title: string; rows: Array<{ name: string; value: number; display: string; sub: string }>; empty: string }) {
  const max = Math.max(...rows.map((r) => r.value), 0);
  return (
    <Card>
      <CardHeader title={title} />
      {rows.length === 0 ? (
        <CardBody><p className="text-sm text-muted">{empty}</p></CardBody>
      ) : (
        <ol className="space-y-3 px-5 pt-2 pb-5 sm:px-6" aria-label={title}>
          {rows.map((r, i) => (
            <li key={`${r.name}-${i}`} className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-4 gap-y-1.5">
              <span className="truncate text-sm font-medium text-ink">{r.name}</span>
              <span className="text-sm font-semibold tabular">{r.display}</span>
              <ShareBar value={r.value} max={max} />
              <span className="text-xs text-muted tabular">{r.sub}</span>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

async function run(supabase: Awaited<ReturnType<typeof createClient>>, from: string, to: string) {
  const { data, error } = await supabase.rpc("report_operations", { p_from: from, p_to: to });
  return { r: (data as Report | null) ?? null, error };
}

export default async function ReportsPage({ searchParams }: { searchParams: Promise<{ days?: string; from?: string; to?: string }> }) {
  const access = await requireAccess();
  const sp = await searchParams;
  const { today, timezone } = await businessToday();
  const days = PERIODS.find((p) => String(p) === sp.days) ?? 30;
  const custom = sp.from && sp.to && isIsoDate(sp.from) && isIsoDate(sp.to) && sp.from <= sp.to;
  const from = custom ? sp.from! : addDays(today, -(days - 1));
  const to = custom ? sp.to! : today;
  const length = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
  const periodLabel = custom ? `${length} days` : `${days} days`;
  // The trend: the same report over slices of the period (7 to 13 points), so every figure is priced the same way.
  const size = length <= 14 ? 1 : length <= 45 ? 3 : Math.ceil(length / 13);
  const slices: Array<{ from: string; to: string }> = [];
  for (let d = from; d <= to; d = addDays(d, size)) slices.push({ from: d, to: addDays(d, size - 1) < to ? addDays(d, size - 1) : to });
  const supabase = await createClient();
  const [main, previous, ...series] = await Promise.all([
    run(supabase, from, to),
    run(supabase, addDays(from, -length), addDays(from, -1)),
    ...(length <= 366 ? slices.map((x) => run(supabase, x.from, x.to)) : []),
  ]);
  const { r, error } = main;
  const prev = previous.r;
  const bases = await listBases();
  // Quote win/loss (B95) for people who can see quotes; a failure leaves the rest of the report standing.
  const quoteOutcomes = can(access, "quotes.view") ? await loadQuoteOutcomes(from, to, timezone).catch(() => null) : null;
  // Driver scorecard (B96): every driver, for people with dispatch or employee access (the database checks it again).
  const scorecard = can(access, "dispatch.view") || can(access, "employees.view") ? await loadScorecard(from, to).catch(() => null) : null;
  const byBase = bases && bases.length > 1 ? await baseSummary(from, to) : [];
  const short = (d: string) => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${d}T00:00:00Z`));
  const trend = series.map((x, i) => ({
    label: short(slices[i].from),
    value: (x.r?.value?.verified_value_cents ?? 0) / 100,
    tickets: x.r?.deliveries?.tickets ?? 0,
    loads: (x.r?.fleet ?? []).reduce((t, f) => t + f.loads, 0),
    detail: `${x.r?.deliveries?.tickets ?? 0} tickets`,
    range: size > 1 ? `${short(slices[i].from)} – ${short(slices[i].to)}` : short(slices[i].from),
  }));
  const loads = (x: Report | null) => (x?.fleet ? x.fleet.reduce((t, f) => t + f.loads, 0) : null);

  return (
    <>
      <PageHeader
        title="Reports"
        description={`Measured from your own records, ${formatDate(from)} – ${formatDate(to)}. Nothing here is estimated; where data is missing, the report says so.`}
      />
      <form className="mb-6 flex flex-wrap items-end gap-x-3 gap-y-4" aria-label="Period">
        <nav aria-label="Periods" className="flex gap-1 rounded-full bg-ink/[0.05] p-1">
          {PERIODS.map((p) => (
            <Link key={p} href={`/reports?days=${p}`} aria-current={!custom && days === p ? "page" : undefined}
              className={cn("flex h-8 items-center rounded-full px-4 text-sm font-semibold whitespace-nowrap", !custom && days === p ? "bg-card text-ink shadow-xs" : "text-muted hover:text-ink")}>
              <span className="pill-text">Last {p} days</span>
            </Link>
          ))}
        </nav>
        <DateRangeFields key={`${from}-${to}`} from={from} to={to} />
        <button className="h-10 rounded-full bg-strong px-5 text-sm font-semibold text-white"><span className="pill-text">Show</span></button>
      </form>

      {error || !r ? (
        <Notice tone="warning" title="The report could not be produced">{error?.message?.includes("one year") ? "Choose a period of up to one year." : "Try again, or choose a shorter period."}</Notice>
      ) : (
        <div className="space-y-5">
          <section aria-label="Key figures" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {r.value ? (
              <Kpi icon={<CircleDollarSign className="size-4" aria-hidden />} label="Verified delivered value" value={formatCents(r.value.verified_value_cents)} spark={trend.map((t) => t.value)} sparkLabel="Verified value trend over the period">
                <Delta now={r.value.verified_value_cents} before={prev?.value?.verified_value_cents ?? null} period={periodLabel} />
              </Kpi>
            ) : null}
            <Kpi icon={<Ticket className="size-4" aria-hidden />} label="Delivery tickets" value={r.deliveries ? String(r.deliveries.tickets) : "—"} spark={trend.map((t) => t.tickets)} sparkLabel="Delivery tickets over the period">
              {r.deliveries ? <Delta now={r.deliveries.tickets} before={prev?.deliveries?.tickets ?? null} period={periodLabel} /> : null}
            </Kpi>
            <Kpi icon={<Truck className="size-4" aria-hidden />} label="Loads assigned" value={loads(r) === null ? "—" : String(loads(r))} spark={trend.map((t) => t.loads)} sparkLabel="Loads assigned over the period">
              {loads(r) !== null ? <Delta now={loads(r)!} before={loads(prev)} period={periodLabel} /> : null}
            </Kpi>
            {r.billing ? (
              <Kpi icon={<Timer className="size-4" aria-hidden />} label="Delivery → billing (median)" value={r.billing.median_days_delivery_to_handoff == null ? "—" : `${r.billing.median_days_delivery_to_handoff} days`}>
                <p className="text-xs text-muted">{r.billing.handed_off_orders} order{r.billing.handed_off_orders === 1 ? "" : "s"} handed off in this period</p>
              </Kpi>
            ) : null}
          </section>

          <div className="grid gap-4 xl:grid-cols-3">
            {r.value ? (
              <section aria-label="Verified delivered value" className="xl:col-span-2">
                <Card className="h-full">
                  <CardHeader title="Verified delivered value" description={`Per ${size === 1 ? "day" : `${size} days`}. Accepted ticket quantities × the order's approved rate, before percentage charges, discounts and tax — not invoiced amounts.`} />
                  <div className="px-3 pb-4 sm:px-5">
                    {trend.some((t) => t.value > 0) ? (
                      <AreaChart points={trend.map((t) => ({ label: t.label, value: t.value, detail: `${t.range} · ${t.detail}` }))} format={(n) => compactMoney(n * 100)} label={`Verified delivered value per ${size === 1 ? "day" : `${size} days`}: ${trend.map((t) => `${t.range} ${formatCents(Math.round(t.value * 100))}`).join("; ")}`} />
                    ) : (
                      <p className="px-2 py-10 text-center text-sm text-muted">No verified deliveries in this period.</p>
                    )}
                  </div>
                </Card>
              </section>
            ) : (
              <section aria-label="Loads over time" className="xl:col-span-2">
                <Card className="h-full">
                  <CardHeader title="Loads assigned" description={`Per ${size === 1 ? "day" : `${size} days`}, from dispatch.`} />
                  <div className="px-3 pb-4 sm:px-5">
                    {trend.some((t) => t.loads > 0) ? (
                      <AreaChart points={trend.map((t) => ({ label: t.label, value: t.loads, detail: t.range }))} format={(n) => trimNumber(Math.round(n * 10) / 10)} label={`Loads assigned per ${size === 1 ? "day" : `${size} days`}: ${trend.map((t) => `${t.range} ${t.loads}`).join("; ")}`} />
                    ) : (
                      <p className="px-2 py-10 text-center text-sm text-muted">No loads assigned in this period.</p>
                    )}
                  </div>
                </Card>
              </section>
            )}
            <section aria-label="Deliveries and rework">
            <Card className="h-full">
              <CardHeader title="Ticket acceptance" description="Delivery tickets the office has accepted." />
              {r.deliveries ? (
                <div className="flex flex-col items-center px-5 pb-6 text-center sm:px-6">
                  <div className="relative w-full max-w-64">
                    <Gauge rate={r.deliveries.tickets ? r.deliveries.accepted / r.deliveries.tickets : null} label={`${pct(r.deliveries.accepted, r.deliveries.tickets)} of delivery tickets accepted`} />
                    <p className="absolute inset-x-0 bottom-1 text-3xl font-semibold tabular">{pct(r.deliveries.accepted, r.deliveries.tickets)}</p>
                  </div>
                  <p className="mt-2 text-sm"><span className="font-semibold tabular">{r.deliveries.accepted}/{r.deliveries.tickets}</span> <span className="text-muted">accepted</span></p>
                  <dl className="mt-4 grid w-full grid-cols-3 gap-2 text-left">
                    <MiniStat label="Waiting" value={String(r.deliveries.pending)} attention={r.deliveries.pending > 0} />
                    <MiniStat label="Corrected" value={pct(r.deliveries.corrected, r.deliveries.tickets)} />
                    <MiniStat label="Voided" value={pct(r.deliveries.voided, r.deliveries.tickets)} />
                  </dl>
                  <p className="mt-3 text-xs text-muted">Median from delivery to acceptance: {r.deliveries.median_hours_to_accept === null ? "—" : `${r.deliveries.median_hours_to_accept} h`}</p>
                </div>
              ) : (
                <CardBody><p className="text-sm text-muted">Delivery tickets are not tracked yet.</p></CardBody>
              )}
            </Card>
            </section>
          </div>

          {r.value ? (
            <div className="grid gap-4 xl:grid-cols-3">
              <Card>
                <CardHeader title="By material" description="Share of verified value." />
                {r.value.by_line.length === 0 ? (
                  <CardBody><p className="text-sm text-muted">No verified deliveries in this period.</p></CardBody>
                ) : (
                  <div className="flex flex-col items-center gap-4 px-5 pb-5 sm:px-6">
                    <Donut parts={r.value.by_line.slice(0, 6).map((l) => ({ label: l.name ?? "Not recorded", value: l.value_cents }))} center={compactMoney(r.value.verified_value_cents)} sub="verified" label={`Verified value by material: ${r.value.by_line.map((l) => `${l.name ?? "Not recorded"} ${formatCents(l.value_cents)}`).join("; ")}`} />
                    <ul className="w-full space-y-2" aria-label="By material">
                      {r.value.by_line.slice(0, 6).map((l, i) => (
                        <li key={`${l.name}-${i}`} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2.5 text-sm">
                          <span className="size-2.5 rounded-full" style={{ background: SERIES[i % SERIES.length] }} aria-hidden />
                          <span className="truncate">{l.name ?? "Not recorded"} <span className="text-xs text-muted">· {l.quantity !== undefined ? `${trimNumber(l.quantity)} ${l.unit ?? ""}` : `${l.tickets} tickets`}</span></span>
                          <span className="font-semibold tabular">{formatCents(l.value_cents)}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </Card>
              <RankList title="By customer" empty="No verified deliveries in this period." rows={r.value.by_customer.map((c) => ({ name: c.name ?? "Not recorded", value: c.value_cents, display: formatCents(c.value_cents), sub: `${c.tickets} ticket${c.tickets === 1 ? "" : "s"}` }))} />
              <RankList title="By truck" empty="No verified deliveries in this period." rows={r.value.by_truck.map((t) => ({ name: t.name ? `Truck ${t.name}` : "Not recorded", value: t.value_cents, display: formatCents(t.value_cents), sub: `${t.tickets} ticket${t.tickets === 1 ? "" : "s"}` }))} />
            </div>
          ) : null}

          {r.billing || r.value ? (
            <Card>
              <CardHeader title="Needs attention" description="Work that is delivered but not yet billable or billed. All periods unless noted." />
              <div className="grid gap-3 px-5 pb-5 sm:grid-cols-2 sm:px-6 xl:grid-cols-4">
                {r.billing ? <MiniStat label="Ready to bill, not handed off" value={String(r.billing.ready_not_handed_off)} sub={`Orders worth ${formatCents(r.billing.ready_ordered_total_cents)} as ordered`} attention={r.billing.ready_not_handed_off > 0} /> : null}
                {r.billing ? <MiniStat label="Loads with no ticket" value={String(r.billing.loads_missing_tickets)} sub={`On ${r.billing.orders_with_missing_tickets} orders — charges at risk until entered`} attention={r.billing.loads_missing_tickets > 0} /> : null}
                {r.value ? <MiniStat label="Accepted tickets not priced" value={String(r.value.unpriced_tickets)} sub="This period: other unit than the order line, or no rate" attention={r.value.unpriced_tickets > 0} /> : null}
                {r.billing ? <MiniStat label="Orders handed off" value={String(r.billing.handed_off_orders)} sub="This period, not reverted" /> : null}
              </div>
            </Card>
          ) : null}

          {byBase.length > 1 ? <BaseReport rows={byBase} bases={bases ?? []} /> : null}

          {r.fleet ? (
            <section aria-label="Truck utilization">
              <Card>
                <CardHeader title="Truck utilization and downtime" description={`Assigned loads and days with loads from dispatch; days out of service from each truck's service history. ${r.days} days in the period.`} />
                {r.fleet.length === 0 ? (
                  <CardBody><p className="text-sm text-muted">No active trucks.</p></CardBody>
                ) : (
                  <TableWrap>
                    <Table aria-label="Truck utilization">
                      <thead>
                        <tr>
                          <Th>Truck</Th>
                          <Th align="right">Loads assigned</Th>
                          <Th className="w-[40%]">Days with loads</Th>
                          <Th align="right">Days out of service</Th>
                        </tr>
                      </thead>
                      <tbody>
                        {r.fleet.slice(0, 50).map((t) => (
                          <Tr key={t.unit_number}>
                            <Td className="font-semibold">{t.unit_number}</Td>
                            <Td align="right" className="tabular">{t.loads}</Td>
                            <Td>
                              <div className="grid grid-cols-[minmax(0,1fr)_5.5rem] items-center gap-3">
                                <ShareBar value={t.days_with_loads} max={r.days} />
                                <span className="text-right text-sm tabular">{t.days_with_loads} <span className="text-muted">({pct(t.days_with_loads, r.days)})</span></span>
                              </div>
                            </Td>
                            <Td align="right" className={cn("tabular", t.days_out_of_service > 0 && "font-semibold text-amber-800")}>{t.days_out_of_service}</Td>
                          </Tr>
                        ))}
                      </tbody>
                    </Table>
                  </TableWrap>
                )}
              </Card>
            </section>
          ) : null}

          {scorecard ? <DriverScorecardTable rows={scorecard} /> : null}

          {quoteOutcomes ? <QuoteOutcomesSection data={quoteOutcomes} /> : null}

          <Notice title="Profitability is not calculated yet">
            Profit per load, truck, customer or material needs cost data Taviron does not have: {r.profitability.missing.join(", ")}. Revenue figures above are verified delivered value only, and no savings or
            return on investment are claimed.
          </Notice>
        </div>
      )}
    </>
  );
}

/** Per dispatch base: each truck, driver and order belongs to exactly one base, so the rows add up to the total row. */
function BaseReport({ rows, bases }: { rows: BaseSummary[]; bases: DispatchBase[] }) {
  const name = new Map(bases.map((b) => [b.id, b]));
  const total = rows.reduce((t, x) => ({ trucks: t.trucks + x.trucks, drivers: t.drivers + x.drivers, orders: t.orders + x.orders, loads: t.loads + x.loads, ordered_cents: t.ordered_cents + x.ordered_cents }), { trucks: 0, drivers: 0, orders: 0, loads: 0, ordered_cents: 0 });
  return (
    <section aria-label="By dispatch base" className="space-y-3">
      <h2 className="text-lg font-bold">By Dispatch Base</h2>
      <p className="text-sm text-muted">Active trucks and drivers today; orders and loads in the period (canceled ones left out). Every record belongs to one base, so nothing is counted twice. Ordered value is as ordered, not invoiced.</p>
      <Card>
        <TableWrap>
          <Table aria-label="Dispatch base report">
            <thead>
              <tr><Th>Base</Th><Th align="right">Trucks</Th><Th align="right">Drivers</Th><Th align="right">Orders</Th><Th align="right">Loads</Th><Th align="right">Ordered value</Th></tr>
            </thead>
            <tbody>
              {rows.map((x) => (
                <Tr key={x.id}>
                  <Td><span className="font-semibold">{name.get(x.id)?.name ?? "Base"}</span> {name.get(x.id) && !name.get(x.id)!.active ? <span className="text-xs text-muted">(inactive)</span> : null}</Td>
                  <Td align="right">{x.trucks}</Td><Td align="right">{x.drivers}</Td><Td align="right">{x.orders}</Td><Td align="right">{x.loads}</Td><Td align="right">{formatCents(x.ordered_cents)}</Td>
                </Tr>
              ))}
              <Tr>
                <Td><span className="font-semibold">All bases</span></Td>
                <Td align="right" className="font-semibold">{total.trucks}</Td><Td align="right" className="font-semibold">{total.drivers}</Td><Td align="right" className="font-semibold">{total.orders}</Td><Td align="right" className="font-semibold">{total.loads}</Td><Td align="right" className="font-semibold">{formatCents(total.ordered_cents)}</Td>
              </Tr>
            </tbody>
          </Table>
        </TableWrap>
      </Card>
    </section>
  );
}
