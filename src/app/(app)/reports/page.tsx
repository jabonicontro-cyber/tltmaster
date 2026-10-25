import Link from "next/link";
import { DateRangeFields } from "@/components/ui/typed-date-input";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { Notice } from "@/components/ui/states";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { addDays, formatDate, isIsoDate } from "@/lib/dates";
import { trimNumber } from "@/lib/fleet/labels";
import { formatCents } from "@/lib/money";
import { requireAccess } from "@/server/auth";
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

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-panel border border-line/70 bg-card shadow-card p-4">
      <p className="text-sm text-muted">{label}</p>
      <p className="mt-1 text-[1.875rem] leading-tight font-semibold tracking-[-0.03em] tabular">{value}</p>
      {sub ? <p className="mt-1 text-xs text-muted">{sub}</p> : null}
    </div>
  );
}

function RankTable({ title, rows, quantity }: { title: string; rows: Ranked[]; quantity?: boolean }) {
  return (
    <Card>
      <CardHeader title={title} />
      {rows.length === 0 ? (
        <CardBody><p className="text-sm text-muted">No verified deliveries in this period.</p></CardBody>
      ) : (
        <TableWrap className="rounded-none border-0">
          <Table aria-label={title}>
            <thead>
              <tr>
                <Th>Name</Th>
                {quantity ? <Th align="right">Quantity</Th> : null}
                <Th align="right">Tickets</Th>
                <Th align="right">Verified value</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <Tr key={`${r.name}-${i}`}>
                  <Td>{r.name ?? <span className="text-muted">Not recorded</span>}</Td>
                  {quantity ? <Td align="right" className="tabular">{r.quantity !== undefined ? `${trimNumber(r.quantity)} ${r.unit ?? ""}` : "—"}</Td> : null}
                  <Td align="right" className="tabular">{r.tickets}</Td>
                  <Td align="right" className="tabular">{formatCents(r.value_cents)}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </TableWrap>
      )}
    </Card>
  );
}

export default async function ReportsPage({ searchParams }: { searchParams: Promise<{ days?: string; from?: string; to?: string }> }) {
  await requireAccess();
  const sp = await searchParams;
  const { today } = await businessToday();
  const days = PERIODS.find((p) => String(p) === sp.days) ?? 30;
  const custom = sp.from && sp.to && isIsoDate(sp.from) && isIsoDate(sp.to) && sp.from <= sp.to;
  const from = custom ? sp.from! : addDays(today, -(days - 1));
  const to = custom ? sp.to! : today;
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("report_operations", { p_from: from, p_to: to });
  const r = data as Report | null;
  const bases = await listBases();
  const byBase = bases && bases.length > 1 ? await baseSummary(from, to) : [];

  return (
    <>
      <PageHeader
        title="Reports"
        description={`Measured from your own records, ${formatDate(from)} – ${formatDate(to)}. Nothing here is estimated; where data is missing, the report says so.`}
      />
      <form className="mb-8 flex flex-wrap items-end gap-x-3 gap-y-6" aria-label="Period">
        {PERIODS.map((p) => (
          <Link key={p} href={`/reports?days=${p}`} className={`rounded-full border px-4 py-2 text-sm font-semibold ${!custom && days === p ? "border-strong bg-strong text-white" : "border-line bg-card hover:bg-surface"}`}>
            Last {p} days
          </Link>
        ))}
        <DateRangeFields key={`${from}-${to}`} from={from} to={to} />
        <button className="h-10 rounded-xl bg-strong px-4 text-sm font-semibold text-white">Show</button>
      </form>

      {error || !r ? (
        <Notice tone="warning" title="The report could not be produced">{error?.message?.includes("one year") ? "Choose a period of up to one year." : "Try again, or choose a shorter period."}</Notice>
      ) : (
        <div className="space-y-6">
          {byBase.length > 1 ? <BaseReport rows={byBase} bases={bases ?? []} /> : null}
          {r.deliveries ? (
            <section aria-label="Deliveries and rework" className="space-y-3">
              <h2 className="text-lg font-bold">Deliveries and rework</h2>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Stat label="Delivery tickets" value={String(r.deliveries.tickets)} sub={`${r.deliveries.accepted} accepted · ${r.deliveries.pending} waiting for review · ${r.deliveries.voided} voided`} />
                <Stat label="Corrected tickets" value={String(r.deliveries.corrected)} sub={`${pct(r.deliveries.corrected, r.deliveries.tickets)} of tickets needed a correction (rework)`} />
                <Stat label="Voided tickets" value={pct(r.deliveries.voided, r.deliveries.tickets)} sub="Share of tickets voided" />
                <Stat label="Delivery → accepted (median)" value={r.deliveries.median_hours_to_accept === null ? "—" : `${r.deliveries.median_hours_to_accept} h`} sub="From delivery time to office acceptance" />
              </div>
            </section>
          ) : null}

          {r.value ? (
            <section aria-label="Verified delivered value" className="space-y-3">
              <h2 className="text-lg font-bold">Verified delivered value</h2>
              <p className="text-sm text-muted">Accepted ticket quantities × the order&apos;s approved rate for that line, in the line&apos;s unit — before percentage charges, discounts and tax. Not invoiced amounts.</p>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Stat label="Verified delivered value" value={formatCents(r.value.verified_value_cents)} sub={`${r.value.priced_tickets} accepted tickets priced`} />
                <Stat label="Accepted tickets not priced" value={String(r.value.unpriced_tickets)} sub="Different unit from the order line, or no rate — check them; they are not counted above" />
                {r.billing ? <Stat label="Ready to bill, not handed off" value={String(r.billing.ready_not_handed_off)} sub={`Orders worth ${formatCents(r.billing.ready_ordered_total_cents)} as ordered (all periods)`} /> : null}
                {r.billing ? <Stat label="Loads with no ticket" value={String(r.billing.loads_missing_tickets)} sub={`On ${r.billing.orders_with_missing_tickets} orders (all periods) — charges at risk until a ticket is entered`} /> : null}
              </div>
              <div className="grid gap-4 lg:grid-cols-3">
                <RankTable title="By customer" rows={r.value.by_customer} />
                <RankTable title="By material / line" rows={r.value.by_line} quantity />
                <RankTable title="By truck" rows={r.value.by_truck} />
              </div>
            </section>
          ) : null}

          {r.billing ? (
            <section aria-label="Billing turnaround" className="space-y-3">
              <h2 className="text-lg font-bold">Billing turnaround</h2>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Stat label="Orders handed off to billing" value={String(r.billing.handed_off_orders)} sub="In this period, not reverted" />
                <Stat label="Last delivery → handoff (median)" value={r.billing.median_days_delivery_to_handoff === null ? "—" : `${r.billing.median_days_delivery_to_handoff} days`} sub={r.billing.median_days_delivery_to_handoff === null ? "No handoffs in this period" : "How long verified work waits before billing"} />
              </div>
            </section>
          ) : null}

          {r.fleet ? (
            <section aria-label="Truck utilization" className="space-y-3">
              <h2 className="text-lg font-bold">Truck utilization and downtime</h2>
              <p className="text-sm text-muted">Assigned loads and days with loads from dispatch; days out of service from each truck&apos;s service history. {r.days} days in the period.</p>
              {r.fleet.length === 0 ? (
                <p className="text-sm text-muted">No active trucks.</p>
              ) : (
                <TableWrap>
                  <Table aria-label="Truck utilization">
                    <thead>
                      <tr>
                        <Th>Truck</Th>
                        <Th align="right">Loads assigned</Th>
                        <Th align="right">Days with loads</Th>
                        <Th align="right">Days out of service</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {r.fleet.slice(0, 50).map((t) => (
                        <Tr key={t.unit_number}>
                          <Td className="font-semibold">{t.unit_number}</Td>
                          <Td align="right" className="tabular">{t.loads}</Td>
                          <Td align="right" className="tabular">{t.days_with_loads} <span className="text-muted">({pct(t.days_with_loads, r.days)})</span></Td>
                          <Td align="right" className="tabular">{t.days_out_of_service}</Td>
                        </Tr>
                      ))}
                    </tbody>
                  </Table>
                </TableWrap>
              )}
            </section>
          ) : null}

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
