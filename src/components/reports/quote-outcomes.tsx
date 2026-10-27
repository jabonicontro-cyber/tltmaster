import Link from "next/link";
import { ShareBar } from "@/components/reports/charts";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { formatDate } from "@/lib/dates";
import { formatCents } from "@/lib/money";
import { MIN_DECIDED, type Group, type QuoteOutcomes } from "@/lib/quotes/outcomes";

// Quote win/loss on Reports (B95): measured from decided quotes only; no price is suggested or changed.

const pct = (r: number | null) => (r === null ? "—" : `${Math.round(r * 100)}%`);

function Rate({ g }: { g: Group }) {
  if (g.winRate === null) return <span className="text-xs text-muted">Needs {MIN_DECIDED} decided</span>;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_3rem] items-center gap-3">
      <ShareBar value={g.won} max={g.decided} />
      <span className="text-right text-sm tabular">{pct(g.winRate)}</span>
    </div>
  );
}

function GroupTable({ label, rows, first }: { label: string; rows: Group[]; first: string }) {
  return (
    <TableWrap>
      <Table aria-label={label}>
        <thead>
          <tr><Th>{first}</Th><Th align="right">Won</Th><Th align="right">Lost</Th><Th className="w-[40%]">Win rate</Th></tr>
        </thead>
        <tbody>
          {rows.map((g) => (
            <Tr key={g.key}>
              <Td className="font-semibold">{g.label}</Td>
              <Td align="right" className="tabular">{g.won}</Td>
              <Td align="right" className="tabular">{g.lost}</Td>
              <Td><Rate g={g} /></Td>
            </Tr>
          ))}
        </tbody>
      </Table>
    </TableWrap>
  );
}

export function QuoteOutcomesSection({ data }: { data: QuoteOutcomes }) {
  return (
    <section aria-label="Quotes won and lost" className="space-y-4">
      <Card>
        <CardHeader
          title="Quotes won and lost"
          description={`Quotes accepted (won), declined or expired (lost) in the period above, from your own quote history. Canceled quotes are left out. Nothing here changes a price.`}
        />
        {data.decided === 0 ? (
          <CardBody><p className="text-sm text-muted">No quotes were decided in this period. <Link href="/quotes" className="font-semibold text-brand-fg hover:underline">Open quotes</Link></p></CardBody>
        ) : (
          <CardBody className="space-y-6">
            <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <div><dt className="text-sm text-muted">Win rate</dt><dd className="text-[1.875rem] leading-tight font-semibold tracking-[-0.03em] tabular">{pct(data.winRate)}</dd><dd className="text-xs text-muted">{data.won} won of {data.decided} decided</dd></div>
              <div><dt className="text-sm text-muted">Won value</dt><dd className="text-[1.875rem] leading-tight font-semibold tracking-[-0.03em] tabular">{formatCents(data.wonValueCents)}</dd><dd className="text-xs text-muted">Quoted totals of accepted quotes</dd></div>
              <div><dt className="text-sm text-muted">Lost value</dt><dd className="text-[1.875rem] leading-tight font-semibold tracking-[-0.03em] tabular">{formatCents(data.lostValueCents)}</dd><dd className="text-xs text-muted">{data.lost} declined or expired</dd></div>
              <div><dt className="text-sm text-muted">Time to a decision</dt><dd className="text-[1.875rem] leading-tight font-semibold tracking-[-0.03em] tabular">{data.medianDaysToDecision === null ? "—" : `${data.medianDaysToDecision} days`}</dd><dd className="text-xs text-muted">Median, from first sent</dd></div>
            </dl>
          </CardBody>
        )}
      </Card>

      {data.decided > 0 ? (
        <>
          <Card>
            <CardHeader title="By material or service" description="Each quote counts once per material or catalog charge (such as hauling). Rates are the quoted price per unit of the decided version; a median needs two quotes on that side." />
            {data.materials.length === 0 ? (
              <CardBody><p className="text-sm text-muted">No catalog materials or charges on the decided quotes.</p></CardBody>
            ) : (
              <TableWrap>
                <Table aria-label="Quotes by material or service">
                  <thead>
                    <tr><Th>Material or service</Th><Th align="right">Won</Th><Th align="right">Lost</Th><Th className="w-[28%]">Win rate</Th><Th align="right">Median rate, won</Th><Th align="right">Median rate, lost</Th></tr>
                  </thead>
                  <tbody>
                    {data.materials.slice(0, 20).map((m) => (
                      <Tr key={m.key}>
                        <Td className="font-semibold">{m.label}</Td>
                        <Td align="right" className="tabular">{m.won}</Td>
                        <Td align="right" className="tabular">{m.lost}</Td>
                        <Td><Rate g={m} /></Td>
                        <Td align="right" className="tabular">{m.medianWonCents === null ? "—" : `${formatCents(m.medianWonCents)} / ${m.unit}`}</Td>
                        <Td align="right" className="tabular">{m.medianLostCents === null ? "—" : `${formatCents(m.medianLostCents)} / ${m.unit}`}</Td>
                      </Tr>
                    ))}
                  </tbody>
                </Table>
              </TableWrap>
            )}
          </Card>

          <div className="grid gap-4 xl:grid-cols-2">
            <Card>
              <CardHeader title="By distance from the yard" description={`Straight-line miles from the yard to the job site, not road miles.${data.unlocated ? ` ${data.unlocated} quote${data.unlocated === 1 ? "" : "s"} without a map position for the site or the yard ${data.unlocated === 1 ? "is" : "are"} left out.` : ""}`} />
              {data.distance.length ? <GroupTable label="Quotes by distance" rows={data.distance} first="Distance" /> : <CardBody><p className="text-sm text-muted">Set the yard and job site positions (Route Planner) to see this.</p></CardBody>}
            </Card>
            <Card>
              <CardHeader title="By customer" description="Customers with the most decided quotes in the period." />
              <GroupTable label="Quotes by customer" rows={data.customers.slice(0, 8)} first="Customer" />
            </Card>
          </div>

          <Card>
            <CardHeader title="Why quotes were lost" description="The note recorded when a quote was marked declined or expired, newest first." />
            {data.reasons.length ? (
              <ul className="divide-y divide-line/70">
                {data.reasons.map((r) => (
                  <li key={r.number} className="flex flex-col gap-1 px-5 py-3 sm:flex-row sm:items-baseline sm:gap-4">
                    <span className="w-40 shrink-0 text-sm font-semibold">{r.number}<span className="block text-xs font-normal text-muted">{r.customer}</span></span>
                    <span className="flex-1 text-sm">{r.reason}</span>
                    <span className="text-xs text-muted">{r.status === "expired" ? "Expired" : "Declined"} {formatDate(r.decidedOn)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <CardBody><p className="text-sm text-muted">No reasons recorded. Add a note when you mark a quote declined to see the pattern here.</p></CardBody>
            )}
          </Card>
        </>
      ) : null}
    </section>
  );
}
