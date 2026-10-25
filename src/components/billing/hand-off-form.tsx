"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Send } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Field, Input, Textarea } from "@/components/ui/form";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { formatDate } from "@/lib/dates";
import { formatCents } from "@/lib/money";
import { handOffOrders } from "@/app/(app)/billing/actions";

export interface ReadyOrder {
  order_id: string;
  order_number: string;
  customer_name: string | null;
  customer_po: string;
  project_name: string;
  service_start: string | null;
  service_end: string | null;
  tickets_accepted: number;
  total_cents: number;
  acknowledgment_reason: string | null;
}

/** Ready orders with selection and the "hand off" step (one batch per submit). */
export function HandOffForm({ orders, canManage }: { orders: ReadyOrder[]; canManage: boolean }) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState(false);
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  // One key per opened dialog: a double submit returns the same batch.
  const [key, setKey] = useState("");
  const all = orders.length > 0 && selected.size === orders.length;
  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const chosen = orders.filter((o) => selected.has(o.order_id));
  const total = chosen.reduce((n, o) => n + o.total_cents, 0);

  return (
    <>
      {canManage && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-5 py-3 sm:px-6">
          <p className="text-sm text-muted">{selected.size ? `${selected.size} selected · ${formatCents(total)} order total` : "Select the orders to hand off for billing."}</p>
          <Button icon={<Send className="size-4" />} disabled={!selected.size} onClick={() => { setKey(crypto.randomUUID()); setOpen(true); }}>
            Hand off selected
          </Button>
        </div>
      )}
      <TableWrap>
        <Table>
          <thead>
            <tr>
              {canManage && (
                <Th className="w-10">
                  <input type="checkbox" aria-label="Select all ready orders" className="size-4 accent-brand" checked={all} onChange={() => setSelected(all ? new Set() : new Set(orders.map((o) => o.order_id)))} />
                </Th>
              )}
              <Th>Order</Th>
              <Th className="hidden sm:table-cell">Service dates</Th>
              <Th className="hidden md:table-cell">Tickets</Th>
              <Th align="right">Order total</Th>
            </tr>
          </thead>
          <tbody>
            {orders.map((o) => (
              <Tr key={o.order_id}>
                {canManage && (
                  <Td>
                    <input type="checkbox" aria-label={`Select ${o.order_number}`} className="size-4 accent-brand" checked={selected.has(o.order_id)} onChange={() => toggle(o.order_id)} />
                  </Td>
                )}
                <Td>
                  <Link href={`/billing/orders/${o.order_id}`} className="font-semibold tabular hover:underline">{o.order_number}</Link>
                  <div className="text-sm text-muted">{o.customer_name}{o.customer_po ? ` · PO ${o.customer_po}` : ""}</div>
                  {o.acknowledgment_reason && <div className="text-xs text-muted">Exceptions acknowledged: {o.acknowledgment_reason}</div>}
                </Td>
                <Td className="hidden sm:table-cell tabular">{formatDate(o.service_start)}{o.service_end && o.service_end !== o.service_start ? ` – ${formatDate(o.service_end)}` : ""}</Td>
                <Td className="hidden md:table-cell tabular">{o.tickets_accepted} accepted</Td>
                <Td align="right" className="tabular">{formatCents(o.total_cents)}</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </TableWrap>

      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={`Hand off ${chosen.length} order${chosen.length === 1 ? "" : "s"} for billing`}
        description="Creates a numbered batch and marks these orders as handed off. It does not create invoices or change prices; enter the invoices in your accounting system from the batch file. An order can be in only one active batch."
        confirmLabel="Create batch"
        onConfirm={async () => {
          const r = await handOffOrders({ orderIds: chosen.map((o) => o.order_id), reference, notes, submissionKey: key });
          if (!r.ok) return r.error;
          toast.success(r.message ?? "Saved");
          setSelected(new Set());
          router.push(`/billing?view=handed_off&batch=${r.data.handoffId}`);
        }}
      >
        <p className="text-sm">{chosen.map((o) => o.order_number).join(", ")}</p>
        <Field label="Reference (optional)" htmlFor="handoff-ref" hint="For example the accounting batch or the person entering the invoices.">
          <Input id="handoff-ref" maxLength={80} value={reference} onChange={(e) => setReference(e.target.value)} />
        </Field>
        <Field label="Notes (optional)" htmlFor="handoff-notes">
          <Textarea id="handoff-notes" rows={2} maxLength={1000} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
      </ConfirmDialog>
    </>
  );
}
