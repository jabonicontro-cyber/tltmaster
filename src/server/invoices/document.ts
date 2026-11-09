import "server-only";
import { balanceCents, paidCents } from "@/lib/billing/invoices";
import { formatDate } from "@/lib/dates";
import { trimNumber } from "@/lib/fleet/labels";
import { formatCents } from "@/lib/money";
import { invoiceSender, type Invoice } from "@/server/data/invoices";
import type { InvoiceDocument } from "@/server/pdf/invoice-pdf";

/** The PDF's built-in fonts cover Latin text only: arrows and similar symbols become plain characters. */
const pdfText = (v: string) => v.replace(/[→⟶➝]/g, "->").replace(/[←]/g, "<-").replace(/[^\x20-\x7E\u00A0-\u00FF\u2013\u2014\u2018\u2019\u201C\u201D\u2022\u2026]/g, "");

/** The printable invoice, from the stored invoice only (its frozen handoff lines), with the company's branding. */
export async function buildInvoiceDocument(inv: Invoice): Promise<InvoiceDocument> {
  const sender = await invoiceSender(inv);
  const b = inv.bill_to;
  const cityLine = [b.city, [b.state, b.postal_code].filter(Boolean).join(" ")].filter((x) => x && x.trim()).join(", ");
  const number = inv.number ?? "Draft";
  const paid = paidCents(inv);
  return {
    title: `Invoice ${number}`,
    filename: `Invoice-${number}.pdf`.replace(/[^A-Za-z0-9._-]/g, "-"),
    isDraft: inv.status === "draft",
    isVoid: inv.status === "void",
    number,
    issueDate: inv.issue_date ? formatDate(inv.issue_date) : "Not issued",
    dueDate: inv.due_date ? formatDate(inv.due_date) : "–",
    terms: inv.terms_days === 0 ? "Due on receipt" : `Net ${inv.terms_days}`,
    sender,
    billTo: { name: b.name, customerNumber: b.customer_number ?? "", addressLines: [b.line1, b.line2, cityLine].filter((l): l is string => Boolean(l && l.trim())) },
    orderNumber: inv.order_number,
    customerPo: inv.customer_po,
    poLabel: inv.po_label,
    projectName: pdfText(inv.project_name),
    serviceDates: inv.service_start ? (inv.service_end && inv.service_end !== inv.service_start ? `${formatDate(inv.service_start)} – ${formatDate(inv.service_end)}` : formatDate(inv.service_start)) : "",
    lines: inv.lines.map((l, i) => {
      const qty = l.delivered_quantity ?? l.quantity;
      return {
        no: i + 1,
        description: pdfText(l.description),
        quantity: qty != null && l.calc_method !== "percent" ? trimNumber(String(qty)) : "",
        unit: l.unit_code ?? "",
        rate: l.unit_rate_cents != null && l.calc_method !== "percent" ? formatCents(Number(l.unit_rate_cents)) : "",
        amount: formatCents(Number(l.amount_cents)),
      };
    }),
    totals: {
      subtotal: formatCents(inv.subtotal_cents),
      discount: inv.discount_cents ? `-${formatCents(Math.abs(inv.discount_cents))}` : null,
      tax: inv.tax_cents ? formatCents(inv.tax_cents) : null,
      total: formatCents(inv.total_cents),
      paid: paid ? formatCents(paid) : null,
      balance: formatCents(inv.status === "issued" ? balanceCents(inv) : inv.status === "draft" ? inv.total_cents : 0),
    },
    footer: pdfText(inv.footer),
  };
}
