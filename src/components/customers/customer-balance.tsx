import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { formatDate } from "@/lib/dates";
import { formatCents } from "@/lib/money";
import { balanceCents, invoiceState, STATE_LABEL, type InvoiceLite } from "@/lib/billing/invoices";
import { createClient } from "@/server/supabase/server";

type Row = Pick<InvoiceLite, "status" | "total_cents" | "payments" | "due_date"> & { id: string; number: string | null; issue_date: string | null };

/**
 * What the customer owes (UX10): issued invoices less recorded payments, what is past due, and the latest invoices.
 * Only for companies that issue invoices in Taviron; nothing is shown before invoicing is set up or without invoices.
 */
export async function CustomerBalance({ customerId, today }: { customerId: string; today: string }) {
  const { data, error } = await (await createClient()).from("invoices")
    .select("id, number, status, total_cents, due_date, issue_date, payments:invoice_payments(amount_cents, voided_at)")
    .eq("customer_id", customerId).neq("status", "draft").order("issue_date", { ascending: false }).limit(100);
  if (error || !data?.length) return null;
  const rows = (data as unknown as Row[]).filter((r) => r.status !== "void");
  if (!rows.length) return null;
  const owed = rows.reduce((n, r) => n + balanceCents(r), 0);
  const late = rows.filter((r) => invoiceState(r, today) === "overdue").reduce((n, r) => n + balanceCents(r), 0);
  return (
    <Card>
      <CardHeader title="Invoices and balance" description="Issued invoices less the payments recorded in Taviron."
        actions={<Link href="/billing/invoices" className="text-sm font-semibold text-brand-fg hover:underline">All invoices</Link>} />
      <CardBody className="space-y-4">
        <div className="flex flex-wrap gap-6">
          <p><span className="block text-xs text-muted">Balance owed</span><span className="text-2xl font-semibold tabular">{formatCents(owed)}</span></p>
          <p><span className="block text-xs text-muted">Past due</span><span className={late ? "text-2xl font-semibold tabular text-critical" : "text-2xl font-semibold tabular"}>{formatCents(late)}</span></p>
        </div>
        <ul className="divide-y divide-line" aria-label="Latest invoices">
          {rows.slice(0, 5).map((r) => {
            const st = STATE_LABEL[invoiceState(r, today)];
            return (
              <li key={r.id}>
                <Link href={`/billing/invoices/${r.id}`} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm hover:bg-surface">
                  <span className="font-semibold tabular">{r.number}<span className="ml-2 font-normal text-muted">{r.issue_date ? formatDate(r.issue_date) : ""}{r.due_date ? ` · due ${formatDate(r.due_date)}` : ""}</span></span>
                  <span className="flex items-center gap-2 tabular">{formatCents(balanceCents(r))}<Badge tone={st.tone}>{st.label}</Badge></span>
                </Link>
              </li>
            );
          })}
        </ul>
      </CardBody>
    </Card>
  );
}
