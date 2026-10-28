import Link from "next/link";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { StatTile } from "@/components/ui/stat-tile";
import { Notice } from "@/components/ui/states";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { CircleDollarSign, Percent, Receipt, Wallet } from "lucide-react";
import { cn } from "@/lib/cn";
import { formatCents } from "@/lib/money";

export interface ProfitRow { name: string; loads: number; revenue_cents: number; cost_cents: number; profit_cents: number; hours?: number }
export interface ProfitReport {
  has_rates: boolean;
  loads: number;
  loads_costed: number;
  loads_without_price: number;
  loads_with_unpriced_tickets: number;
  loads_without_hours: number;
  revenue_cents: number;
  cost_cents: number;
  hours: number;
  by_customer: ProfitRow[];
  by_truck: ProfitRow[];
}

const margin = (revenue: number, profit: number) => (revenue > 0 ? `${Math.round((profit / revenue) * 100)}%` : "—");

function Rows({ rows, label, hours = false }: { rows: ProfitRow[]; label: string; hours?: boolean }) {
  return (
    <TableWrap>
      <Table aria-label={label}>
        <thead>
          <tr><Th>{label === "Profit by customer" ? "Customer" : "Truck"}</Th><Th align="right">Loads</Th>{hours && <Th align="right" className="hidden sm:table-cell">Hours</Th>}<Th align="right" className="hidden md:table-cell">Revenue</Th><Th align="right" className="hidden md:table-cell">Est. cost</Th><Th align="right">Est. profit</Th><Th align="right">Margin</Th></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <Tr key={r.name}>
              <Td className="font-medium">{r.name}</Td>
              <Td align="right" className="tabular">{r.loads}</Td>
              {hours && <Td align="right" className="hidden tabular sm:table-cell">{Math.round((r.hours ?? 0) * 10) / 10}</Td>}
              <Td align="right" className="hidden tabular md:table-cell">{formatCents(r.revenue_cents)}</Td>
              <Td align="right" className="hidden tabular md:table-cell">{formatCents(r.cost_cents)}</Td>
              <Td align="right" className={cn("font-semibold tabular", r.profit_cents < 0 && "text-critical")}>{formatCents(r.profit_cents)}</Td>
              <Td align="right" className="tabular">{margin(r.revenue_cents, r.profit_cents)}</Td>
            </Tr>
          ))}
        </tbody>
      </Table>
    </TableWrap>
  );
}

/**
 * Profit per load (B104): verified revenue minus the company's own cost rates applied to each load's planned hours.
 * Estimates are labelled; loads that cannot be priced or timed are counted and left out, never guessed.
 */
export function ProfitSection({ data, canEditRates }: { data: ProfitReport; canEditRates: boolean }) {
  if (!data.has_rates) {
    return (
      <Notice title="Profit per load needs your cost rates">
        Add your truck and driver cost per hour and any fixed cost per load in{" "}
        {canEditRates ? <Link href="/settings?tab=costs" className="font-semibold underline">Settings → Cost rates</Link> : "Settings → Cost rates (someone who manages billing)"}
        . Until then only verified revenue is shown; nothing is guessed.
      </Notice>
    );
  }
  const profit = data.revenue_cents - data.cost_cents;
  const left = [
    data.loads_without_price ? `${data.loads_without_price} without a priced ticket` : "",
    data.loads_without_hours ? `${data.loads_without_hours} without planned hours` : "",
  ].filter(Boolean).join(" and ");
  return (
    <section aria-label="Profit" className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile icon={<CircleDollarSign />} tone="brand" label="Revenue (costed loads)" value={formatCents(data.revenue_cents).replace(/\.\d\d$/, "")}>
          <span className="text-muted">{data.loads_costed} of {data.loads} delivered loads</span>
        </StatTile>
        <StatTile icon={<Receipt />} label="Estimated cost" value={formatCents(data.cost_cents).replace(/\.\d\d$/, "")}>
          <span className="text-muted">{Math.round(data.hours)} planned hours</span>
        </StatTile>
        <StatTile icon={<Wallet />} tone={profit < 0 ? "critical" : "green"} label="Estimated profit" value={formatCents(profit).replace(/\.\d\d$/, "")}>
          <span className="text-muted">revenue minus estimated cost</span>
        </StatTile>
        <StatTile icon={<Percent />} tone="neutral" label="Margin" value={margin(data.revenue_cents, profit)}>
          <span className="text-muted">of costed revenue</span>
        </StatTile>
      </div>
      {left && <p className="px-1 text-sm text-muted">Left out of profit: {left}.</p>}
      {data.by_customer.length > 0 && (
        <Card>
          <CardHeader title="Profit by customer" description="Estimated: planned hours × your cost rates, plus the fixed cost per load. Lowest margins are worth a look at the rate." />
          <Rows rows={data.by_customer} label="Profit by customer" />
        </Card>
      )}
      {data.by_truck.length > 0 && (
        <Card>
          <CardHeader title="Profit by truck" />
          <Rows rows={data.by_truck} label="Profit by truck" hours />
        </Card>
      )}
      <Card><CardBody><p className="text-xs text-muted">Revenue is verified delivered value (accepted tickets × the approved rate, before percentage charges, discounts and tax). Cost uses the same rates for every truck and driver; actual fuel, pay and repair costs are not read.</p></CardBody></Card>
    </section>
  );
}
