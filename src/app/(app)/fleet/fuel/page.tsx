import Link from "next/link";
import { FleetNav } from "@/components/fleet/fleet-nav";
import { FuelForm, TripSheetForm, VoidFuelButton } from "@/components/fleet/fuel-forms";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { StatTile } from "@/components/ui/stat-tile";
import { EmptyState, Notice } from "@/components/ui/states";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { formatDate } from "@/lib/dates";
import { quarterOf, quarterRange } from "@/lib/fuel/ifta";
import { formatCents } from "@/lib/money";
import { can } from "@/lib/permissions";
import { requirePagePermission } from "@/server/auth";
import { truckOptions } from "@/server/data/fleet";
import { homeState, loadFuel } from "@/server/data/fuel";
import { businessToday } from "@/server/data/settings";
import { Fuel, Gauge, Route } from "lucide-react";

export const metadata = { title: "Fuel and IFTA" };

const fmt = (n: number, d = 1) => n.toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: 0 });

/**
 * Fuel and IFTA (B130): fuel purchases and drivers' daily trip sheets per truck, and the quarter's IFTA summary — miles
 * and gallons per state, the fleet's measured MPG, taxable and net gallons. Tax rates are applied by the company.
 */
export default async function FuelPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const access = await requirePagePermission("fleet.view");
  const { today } = await businessToday();
  const sp = await searchParams;
  const current = quarterOf(today);
  const m = /^(\d{4})-([1-4])$/.exec(sp.q ?? "");
  const year = m ? Number(m[1]) : current.year;
  const quarter = m ? Number(m[2]) : current.quarter;
  const { from, to } = quarterRange(year, quarter);
  const [data, trucks, home] = await Promise.all([loadFuel(from, to), truckOptions(), homeState()]);
  const header = (
    <>
      <PageHeader title="Fleet" description="Trucks, trailers and drivers, with what makes each one ready — or not ready — for work." />
      <FleetNav active="Fuel and IFTA" />
    </>
  );
  if (!data.installed) return <>{header}<Notice title="Not available yet">Fuel and IFTA need a database update that has not been installed yet.</Notice></>;
  const truckName = new Map(trucks.map((t) => [t.id, t.unit_number]));
  const truckList = trucks.filter((t) => t.active).map((t) => ({ id: t.id, label: t.unit_number }));
  const edit = can(access, "fleet.edit");
  const prev = quarter === 1 ? `${year - 1}-4` : `${year}-${quarter - 1}`;
  const next = quarter === 4 ? `${year + 1}-1` : `${year}-${quarter + 1}`;
  const isCurrent = year === current.year && quarter === current.quarter;

  return (
    <>
      {header}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <ButtonLink href={`/fleet/fuel?q=${prev}`} variant="secondary" size="sm">Previous quarter</ButtonLink>
        <span className="px-2 text-base font-semibold text-ink">{year} Q{quarter}</span>
        {!isCurrent && <ButtonLink href={`/fleet/fuel?q=${next}`} variant="secondary" size="sm">Next quarter</ButtonLink>}
        <a href={`/fleet/fuel/ifta.csv?q=${year}-${quarter}`} className="ml-auto text-sm font-semibold text-brand-fg hover:underline">Download IFTA summary (CSV)</a>
      </div>
      <div className="mb-5 grid gap-4 sm:grid-cols-3">
        <StatTile icon={<Route />} label="Miles" value={fmt(data.summary.miles, 0)} muted={!data.summary.miles}>From {data.sheets.filter((s) => !s.voided).length} trip sheets</StatTile>
        <StatTile icon={<Fuel />} label="Gallons bought" value={fmt(data.summary.gallons)} muted={!data.summary.gallons}>{data.purchases.filter((p) => !p.voided).length} purchases</StatTile>
        <StatTile icon={<Gauge />} label="Fleet MPG" value={data.summary.mpg === null ? "—" : fmt(data.summary.mpg, 2)} muted={data.summary.mpg === null}>{data.summary.mpg === null ? "Needs fuel and miles" : "Miles ÷ gallons, this quarter"}</StatTile>
      </div>

      <Card className="mb-5">
        <CardHeader title={`IFTA summary — ${year} Q${quarter}`} description="Taxable gallons are each state's miles divided by the fleet MPG; net is taxable minus the gallons bought there (negative = credit). Apply this quarter's official IFTA tax rates to the net gallons." />
        {data.summary.rows.length === 0 ? <CardBody><EmptyState title="No trip sheets or fuel this quarter" /></CardBody> : (
          <TableWrap className="rounded-none border-0 border-t border-line">
            <Table aria-label="IFTA summary">
              <thead><tr><Th>State</Th><Th align="right">Miles</Th><Th align="right">Gallons bought</Th><Th align="right">Taxable gallons</Th><Th align="right">Net taxable gallons</Th></tr></thead>
              <tbody>
                {data.summary.rows.map((r) => (
                  <Tr key={r.jurisdiction}>
                    <Td className="font-semibold">{r.jurisdiction}</Td>
                    <Td align="right" className="tabular">{fmt(r.miles, 0)}</Td>
                    <Td align="right" className="tabular">{fmt(r.gallonsBought)}</Td>
                    <Td align="right" className="tabular">{r.taxableGallons === null ? "—" : fmt(r.taxableGallons)}</Td>
                    <Td align="right" className="tabular">{r.netGallons === null ? "—" : fmt(r.netGallons)}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </TableWrap>
        )}
      </Card>

      {edit && (
        <div className="mb-5 grid gap-5 lg:grid-cols-2">
          <Card><CardHeader title="Record a trip sheet" description="Drivers do this on My Day; the office can fill in a missing one." /><CardBody><TripSheetForm trucks={truckList} today={today} homeState={home} /></CardBody></Card>
          <Card><CardHeader title="Record fuel" description="From the receipt: state, gallons and total." /><CardBody><FuelForm trucks={truckList} today={today} homeState={home} /></CardBody></Card>
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader title="Trip sheets" />
          {data.sheets.length === 0 ? <CardBody><EmptyState title="None this quarter" /></CardBody> : (
            <ul className="divide-y divide-line border-t border-line" aria-label="Trip sheets">
              {data.sheets.slice(0, 60).map((s) => (
                <li key={s.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-2.5 text-sm sm:px-6">
                  <span className="w-24 text-muted">{formatDate(s.sheet_date)}</span>
                  <span className="font-semibold">{truckName.get(s.truck_id) ?? "Truck"}</span>
                  <span className="min-w-0 flex-1 tabular text-muted">{s.end_odometer - s.start_odometer} mi · {s.legs.map((l) => `${l.jurisdiction} ${l.miles}`).join(", ")}</span>
                  {s.voided ? <Badge tone="gray">Void: {s.void_reason}</Badge> : edit && <VoidFuelButton kind="trip_sheet" id={s.id} />}
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card>
          <CardHeader title="Fuel purchases" />
          {data.purchases.length === 0 ? <CardBody><EmptyState title="None this quarter" /></CardBody> : (
            <ul className="divide-y divide-line border-t border-line" aria-label="Fuel purchases">
              {data.purchases.slice(0, 60).map((p) => (
                <li key={p.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-2.5 text-sm sm:px-6">
                  <span className="w-24 text-muted">{formatDate(p.purchased_on)}</span>
                  <span className="font-semibold">{truckName.get(p.truck_id) ?? "Truck"}</span>
                  <span className="min-w-0 flex-1 tabular text-muted">{p.jurisdiction} · {fmt(p.gallons)} gal · {formatCents(p.total_cents)}{p.vendor ? ` · ${p.vendor}` : ""}</span>
                  {p.voided ? <Badge tone="gray">Void: {p.void_reason}</Badge> : edit && <VoidFuelButton kind="purchase" id={p.id} />}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      <p className="mt-4 text-xs text-muted">Receipt photos are not stored yet; record the receipt number. <Link href="/help" className="underline">Help</Link></p>
    </>
  );
}
