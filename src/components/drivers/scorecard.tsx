import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { share, type ScoreRow } from "@/lib/drivers/scorecard";

// Driver scorecard (B96). Managers: every driver, alphabetical, no ranking. A driver: their own figures only.

const fmt = (p: number | null) => (p === null ? "—" : `${p}%`);

export function DriverScorecardTable({ rows, period }: { rows: ScoreRow[]; period: string }) {
  return (
    <section aria-label="Driver scorecard">
      <Card>
        <CardHeader title="Drivers" description={`${period}. On time: delivered by the end of the load's planned window. Same day: tickets the driver entered on the delivery day. A share needs three behind it. Drivers see only their own figures; there is no ranking.`} />
        {rows.length === 0 ? (
          <CardBody><p className="text-sm text-muted">No drivers yet.</p></CardBody>
        ) : (
          <TableWrap>
            <Table aria-label="Driver scorecard">
              <thead>
                <tr><Th>Driver</Th><Th align="right">Loads delivered</Th><Th align="right">On time</Th><Th align="right">Tickets entered same day</Th><Th align="right">Problems reported</Th></tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <Tr key={r.driver_id}>
                    <Td className="font-semibold">{r.driver_name}</Td>
                    <Td align="right" className="tabular">{r.loads}</Td>
                    <Td align="right" className="tabular">{fmt(share(r.on_time, r.loads))}</Td>
                    <Td align="right" className="tabular">{r.own_tickets ? `${fmt(share(r.same_day, r.own_tickets))} of ${r.own_tickets}` : "—"}</Td>
                    <Td align="right" className="tabular">{r.reports}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </TableWrap>
        )}
      </Card>
    </section>
  );
}

export function MyScorecard({ row, days }: { row: ScoreRow; days: number }) {
  const items = [
    { label: "Loads delivered", value: String(row.loads), note: "" },
    { label: "On time", value: fmt(share(row.on_time, row.loads)), note: "By the end of the planned window" },
    { label: "Tickets entered same day", value: row.own_tickets ? fmt(share(row.same_day, row.own_tickets)) : "—", note: row.own_tickets ? `${row.same_day} of ${row.own_tickets}` : "None entered from your phone yet" },
    { label: "Problems reported", value: String(row.reports), note: "Delays, breakdowns and equipment" },
  ];
  return (
    <section aria-label={`My last ${days} days`}>
      <Card>
        <CardHeader title={`My last ${days} days`} description="From your recorded deliveries and reports. Only you and the office see these." />
        <CardBody>
          <dl className="grid grid-cols-2 gap-4">
            {items.map((i) => (
              <div key={i.label}>
                <dt className="text-sm text-muted">{i.label}</dt>
                <dd className="text-2xl font-semibold tabular">{i.value}</dd>
                {i.note ? <dd className="text-xs text-muted">{i.note}</dd> : null}
              </div>
            ))}
          </dl>
        </CardBody>
      </Card>
    </section>
  );
}
