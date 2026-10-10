import Link from "next/link";
import { QuoteStatusBadge, SampleBadge } from "@/components/ui/badge";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { formatCents } from "@/lib/money";
import { formatDate } from "@/lib/dates";
import { isPastExpiration } from "@/lib/quotes/status";
import type { QuoteListRow } from "@/server/data/types";

export function QuoteTable({ rows, today, showCustomer = true }: { rows: QuoteListRow[]; today: string; showCustomer?: boolean }) {
  return (
    <TableWrap>
      <Table>
        <thead>
          <tr>
            <Th>Quote</Th>
            {showCustomer && <Th>Customer</Th>}
            <Th className="hidden md:table-cell">Job site / project</Th>
            <Th className="hidden sm:table-cell">Expires</Th>
            <Th>Status</Th>
            <Th align="right">Total</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((q) => {
            const overdue = isPastExpiration(q.status, q.valid_until, today);
            return (
              <Tr key={q.id}>
                <Td>
                  <Link href={`/quotes/${q.id}`} className="font-semibold text-ink tabular hover:text-brand hover:underline">
                    {q.quote_number}
                  </Link>
                  <div className="mt-0.5 flex items-center gap-1.5 text-sm text-muted">
                    <span>
                      v{q.version_no} · {formatDate(q.quote_date)}
                    </span>
                    <SampleBadge show={q.is_sample} />
                  </div>
                </Td>
                {showCustomer && (
                  <Td>
                    <Link href={`/customers/${q.customer_id}`} className="hover:underline">
                      {q.customer_name}
                    </Link>
                  </Td>
                )}
                <Td className="hidden md:table-cell">
                  <div>{q.project_name || q.site_label || q.site_line1 || <span className="text-muted">—</span>}</div>
                  {q.site_city && <div className="text-sm text-muted">{q.site_city}</div>}
                </Td>
                <Td className={`hidden whitespace-nowrap sm:table-cell ${overdue ? "font-semibold text-amber-800" : ""}`}>
                  {formatDate(q.valid_until)}
                  {overdue && <div className="text-xs">Past expiration</div>}
                </Td>
                <Td>
                  <QuoteStatusBadge status={q.status} />
                </Td>
                <Td align="right" className="font-semibold whitespace-nowrap">
                  {formatCents(q.total_cents)}
                </Td>
              </Tr>
            );
          })}
        </tbody>
      </Table>
    </TableWrap>
  );
}
