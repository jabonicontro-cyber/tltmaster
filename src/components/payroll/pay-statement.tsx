import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { formatDate } from "@/lib/dates";
import { centsText } from "@/lib/payroll/export";

export type PayStatementData = {
  period: { id: string; starts_on: string; ends_on: string; status: string; approved_at: string | null };
  driver: { id: string; name: string };
  lines: Array<{ ticket: string | null; reference: string | null; delivered_on: string; order_number: string | null; quantity: number; unit: string; amount_cents: number }>;
  adjustments: Array<{ reason: string; amount_cents: number }>;
  earnings_cents: number;
  adjustments_cents: number;
};

const money = (cents: number) => `${cents < 0 ? "−" : ""}$${centsText(Math.abs(cents))}`;
const qty = (n: number) => Number(n).toLocaleString("en-US", { maximumFractionDigits: 3 });

/**
 * A driver's pay statement for one payroll period (B131): each verified ticket with its pay, adjustments and the gross.
 * Printed light (force-light). Gross pay before any taxes or deductions the company's payroll provider applies.
 */
export function PayStatement({ s, company }: { s: PayStatementData; company: string }) {
  const total = s.earnings_cents + s.adjustments_cents;
  return (
    <article className="force-light rounded-panel border border-line/70 bg-card p-6 text-ink shadow-card" aria-label="Pay statement">
      <header className="flex flex-wrap justify-between gap-4 border-b border-line pb-4">
        <div>
          <p className="text-sm text-muted">{company}</p>
          <h2 className="text-xl font-semibold">Pay statement — {s.driver.name}</h2>
          <p className="text-sm text-muted">{formatDate(s.period.starts_on)} – {formatDate(s.period.ends_on)}</p>
        </div>
        <p className="text-right text-sm text-muted">{s.lines.length} ticket{s.lines.length === 1 ? "" : "s"}</p>
      </header>
      <TableWrap className="mt-4 rounded-none border-0">
        <Table aria-label="Tickets">
          <thead><tr><Th>Day</Th><Th>Ticket</Th><Th>Order</Th><Th align="right">Quantity</Th><Th align="right">Pay</Th></tr></thead>
          <tbody>
            {s.lines.length === 0 ? <Tr><Td colSpan={5} className="text-muted">No paid tickets in this period.</Td></Tr> : s.lines.map((l, i) => (
              <Tr key={i}>
                <Td className="whitespace-nowrap">{formatDate(l.delivered_on)}</Td>
                <Td>{l.ticket ?? "—"}{l.reference ? <span className="block text-xs text-muted">{l.reference}</span> : null}</Td>
                <Td>{l.order_number ?? "—"}</Td>
                <Td align="right" className="tabular">{qty(l.quantity)} {l.unit}</Td>
                <Td align="right" className="tabular">{money(l.amount_cents)}</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </TableWrap>
      <dl className="mt-4 ml-auto w-full max-w-sm space-y-1 text-[15px]" aria-label="Totals">
        <div className="flex justify-between"><dt>Ticket pay</dt><dd className="tabular">{money(s.earnings_cents)}</dd></div>
        {s.adjustments.map((a, i) => (
          <div key={i} className="flex justify-between gap-2 text-muted"><dt className="min-w-0 truncate">{a.reason || "Adjustment"}</dt><dd className="tabular">{money(a.amount_cents)}</dd></div>
        ))}
        <div className="flex justify-between border-t-2 border-strong pt-1 text-lg font-bold"><dt>Gross pay</dt><dd className="tabular">{money(total)}</dd></div>
      </dl>
      <p className="mt-4 text-xs text-muted">Gross pay before taxes and deductions. Questions about a ticket go to the office.</p>
    </article>
  );
}
