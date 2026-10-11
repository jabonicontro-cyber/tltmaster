import { FileText } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import type { InvoiceDraft, QuantityBasis } from "@/lib/billing/invoice-draft";
import { trimNumber } from "@/lib/fleet/labels";
import { formatCents } from "@/lib/money";

const BASIS: Record<QuantityBasis, { label: string; tone: "green" | "amber" | "gray" }> = {
  delivered: { label: "Delivered (accepted tickets)", tone: "green" },
  ordered_no_tickets: { label: "Ordered — confirm", tone: "amber" },
  ordered_fixed: { label: "As ordered", tone: "gray" },
  percentage: { label: "Percentage", tone: "gray" },
};

/**
 * The invoice draft: what this order would be invoiced at from verified
 * deliveries and the order's approved prices. Not an invoice: nothing is
 * stored, issued, sent or recorded in accounting.
 */
export function InvoiceDraftCard({ draft }: { draft: InvoiceDraft }) {
  const diff = draft.differenceCents;
  return (
    <Card>
      <CardHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            <FileText className="size-5 text-muted" aria-hidden /> Invoice draft
            <Badge tone={draft.stage === "draft" ? "green" : "amber"}>{draft.stage === "draft" ? "Draft" : "Preview — not ready for billing"}</Badge>
          </span>
        }
        description="Prepared from accepted delivery tickets and the order's approved prices. This is not an invoice: nothing has been issued, sent or recorded in accounting."
      />
      {draft.blockers.length > 0 || draft.needsConfirmation > 0 ? (
        <CardBody className="border-b border-line">
          <ul className="list-disc space-y-1 pl-5 text-sm text-amber-950">
            {draft.blockers.map((b) => (
              <li key={b}>{b}</li>
            ))}
            {draft.needsConfirmation > 0 ? <li>{draft.needsConfirmation} line{draft.needsConfirmation === 1 ? " needs" : "s need"} confirmation (see below).</li> : null}
          </ul>
        </CardBody>
      ) : null}
      <TableWrap className="rounded-none border-0">
        <Table aria-label="Invoice draft">
          <thead>
            <tr>
              <Th>Line</Th>
              <Th>Quantity from</Th>
              <Th align="right">Quantity</Th>
              <Th align="right">Rate</Th>
              <Th align="right">Amount</Th>
            </tr>
          </thead>
          <tbody>
            {draft.lines.map((l) => (
              <Tr key={l.lineId}>
                <Td>
                  <span className="text-muted">{l.lineNo}.</span> {l.description}
                  {l.warnings.map((w) => (
                    <div key={w} className="text-xs text-amber-900">{w}</div>
                  ))}
                </Td>
                <Td><Badge tone={BASIS[l.basis].tone}>{BASIS[l.basis].label}</Badge></Td>
                <Td align="right" className="tabular">
                  {l.quantity === null ? "—" : `${trimNumber(l.quantity)} ${l.unitCode ?? ""}`}
                  {l.basis === "delivered" && l.orderedQuantity !== null && l.orderedQuantity !== l.quantity ? (
                    <div className="text-xs text-muted">ordered {trimNumber(l.orderedQuantity)}</div>
                  ) : null}
                </Td>
                <Td align="right" className="tabular">{l.percentBp !== null && l.basis === "percentage" ? `${(l.percentBp / 100).toFixed(2)}%` : formatCents(l.rateCents ?? 0)}</Td>
                <Td align="right" className="tabular">{formatCents(l.amountCents)}</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </TableWrap>
      <CardBody className="space-y-1 border-t border-line text-sm">
        <p className="flex justify-between"><span>Subtotal</span><span className="tabular">{formatCents(draft.subtotalCents)}</span></p>
        {draft.discountCents ? <p className="flex justify-between"><span>Discounts</span><span className="tabular">−{formatCents(draft.discountCents)}</span></p> : null}
        <p className="flex justify-between"><span>Tax</span><span className="tabular">{formatCents(draft.taxCents)}</span></p>
        <p className="flex justify-between font-bold"><span>Draft total</span><span className="tabular">{formatCents(draft.totalCents)}</span></p>
        <p className="flex justify-between text-muted">
          <span>Order total (ordered quantities)</span>
          <span className="tabular">{formatCents(draft.orderedTotalCents)}{diff !== 0 ? ` · ${diff > 0 ? "+" : "−"}${formatCents(Math.abs(diff))} difference` : " · no difference"}</span>
        </p>
      </CardBody>
    </Card>
  );
}
