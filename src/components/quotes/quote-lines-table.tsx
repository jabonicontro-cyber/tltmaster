import { Badge } from "@/components/ui/badge";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { formatBp, formatCents, formatQuantity, numericToMilli } from "@/lib/money";
import { CHARGE_KIND_LABELS } from "@/lib/schemas/catalog";
import type { QuoteLineRow } from "@/server/data/types";

const SOURCE_LABEL: Record<QuoteLineRow["price_source"], string> = {
  customer: "Customer rate",
  standard: "Standard rate",
  manual: "Manual rate",
  override: "Override",
};

/** Line items with pricing snapshots — used for quote revisions and orders. */
export function QuoteLinesTable({ lines }: { lines: Array<Omit<QuoteLineRow, "quote_version_id">> }) {
  return (
    <TableWrap>
      <Table>
        <thead>
          <tr>
            <Th className="w-10">#</Th>
            <Th>Description</Th>
            <Th align="right">Qty</Th>
            <Th>Unit</Th>
            <Th align="right">Rate</Th>
            <Th align="right">Amount</Th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <Tr key={l.id}>
              <Td className="text-muted tabular">{l.line_no}</Td>
              <Td>
                <div className="font-medium">{l.description}</div>
                <div className="mt-0.5 flex flex-wrap gap-1.5 text-xs text-muted">
                  <span>{CHARGE_KIND_LABELS[l.kind]}</span>
                  <span>·</span>
                  {l.price_source === "override" ? (
                    <Badge tone="amber">
                      Override (configured {l.catalog_rate_cents !== null ? formatCents(l.catalog_rate_cents) : formatBp(l.catalog_percent_bp ?? 0)})
                    </Badge>
                  ) : (
                    <span>{SOURCE_LABEL[l.price_source]}</span>
                  )}
                  {l.taxable && <span>· Taxable</span>}
                </div>
              </Td>
              <Td align="right">{l.quantity !== null ? formatQuantity(numericToMilli(l.quantity) ?? 0) : ""}</Td>
              <Td>{l.unit_label}</Td>
              <Td align="right">{l.calc_method === "per_unit" ? formatCents(l.unit_rate_cents ?? 0) : formatBp(l.percent_bp ?? 0)}</Td>
              <Td align="right" className={l.amount_cents < 0 ? "font-semibold text-green-800" : "font-semibold"}>
                {formatCents(l.amount_cents)}
              </Td>
            </Tr>
          ))}
        </tbody>
      </Table>
    </TableWrap>
  );
}
