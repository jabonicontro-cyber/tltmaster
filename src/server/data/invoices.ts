import "server-only";
import type { InvoiceLite, InvoiceStatus, PaymentMethod } from "@/lib/billing/invoices";
import { createClient } from "@/server/supabase/server";

// Invoices and receivables (B99, migration 20261120004800), read through the person's session (billing.view, RLS).
// Before the migration is installed the loaders say so instead of failing the page.

const MISSING = new Set(["42P01", "PGRST205", "42883", "PGRST202"]);

export type Issuer = "quickbooks" | "taviron";
export interface InvoicingSettings { installed: boolean; issuer: Issuer; termsDays: number; footer: string }

export async function invoicingSettings(): Promise<InvoicingSettings> {
  const { data, error } = await (await createClient()).from("invoicing_settings").select("issuer, terms_days, footer").maybeSingle();
  if (error) return { installed: !MISSING.has(error.code ?? ""), issuer: "quickbooks", termsDays: 30, footer: "" };
  const d = data as { issuer: Issuer; terms_days: number; footer: string } | null;
  return { installed: true, issuer: d?.issuer ?? "quickbooks", termsDays: d?.terms_days ?? 30, footer: d?.footer ?? "" };
}

export interface InvoiceLine {
  line_no: number; kind: string; description: string; unit_code: string | null; quantity: string | null; unit_rate_cents: number | null;
  amount_cents: number; delivered_quantity: string | null; calc_method: string; taxable: boolean;
}
export interface InvoicePayment { id: string; amount_cents: number; received_on: string; method: PaymentMethod; reference: string; note: string; created_at: string; voided_at: string | null; void_reason: string; recorded_by: string | null }
export interface Invoice extends InvoiceLite {
  number: string | null;
  handoff_order_id: string;
  order_id: string;
  order_number: string;
  customer_po: string;
  project_name: string;
  service_start: string | null;
  service_end: string | null;
  bill_to: { name: string; customer_number: string; email: string | null; line1: string | null; line2: string | null; city: string | null; state: string | null; postal_code: string | null };
  issued_by_entity: { name: string; address_line1: string; address_line2: string; city: string; region: string; postal_code: string; phone: string; email: string } | null;
  lines: InvoiceLine[];
  subtotal_cents: number;
  discount_cents: number;
  tax_cents: number;
  terms_days: number;
  footer: string;
  issue_date: string | null;
  sent_at: string | null;
  sent_to: string[];
  void_reason: string;
  created_at: string;
  payments: InvoicePayment[];
}

const COLUMNS = "id, number, status, handoff_order_id, order_id, customer_id, order_number, customer_po, project_name, service_start, service_end, bill_to, issued_by_entity, lines, subtotal_cents, discount_cents, tax_cents, total_cents, terms_days, footer, issue_date, due_date, sent_at, sent_to, void_reason, created_at, invoice_payments(id, amount_cents, received_on, method, reference, note, created_at, voided_at, void_reason, recorded_by)";

type Raw = Omit<Invoice, "payments" | "customer_name"> & { invoice_payments: InvoicePayment[] };
const shape = (r: Raw): Invoice => ({
  ...r,
  total_cents: Number(r.total_cents), subtotal_cents: Number(r.subtotal_cents), discount_cents: Number(r.discount_cents), tax_cents: Number(r.tax_cents),
  customer_name: r.bill_to?.name ?? "Customer",
  payments: (r.invoice_payments ?? []).map((p) => ({ ...p, amount_cents: Number(p.amount_cents) })).sort((a, b) => a.received_on.localeCompare(b.received_on)),
});

/** Every invoice of the company (newest first), with payments. Null before the migration is installed. */
export async function listInvoices(): Promise<Invoice[] | null> {
  const { data, error } = await (await createClient()).from("invoices").select(COLUMNS).order("created_at", { ascending: false }).limit(1000);
  if (error) {
    if (MISSING.has(error.code ?? "")) return null;
    throw new Error(`Invoices: ${error.message}`);
  }
  return ((data ?? []) as unknown as Raw[]).map(shape);
}

export async function getInvoice(id: string): Promise<Invoice | null> {
  const { data, error } = await (await createClient()).from("invoices").select(COLUMNS).eq("id", id).maybeSingle();
  if (error) {
    if (MISSING.has(error.code ?? "")) return null;
    throw new Error(`Invoice: ${error.message}`);
  }
  return data ? shape(data as unknown as Raw) : null;
}

/** Active invoices by handed-off order, for the Billing board's Handed off view. */
export async function invoicesByHandoff(handoffOrderIds: string[]): Promise<Record<string, { id: string; number: string | null; status: InvoiceStatus }>> {
  if (!handoffOrderIds.length) return {};
  const { data, error } = await (await createClient()).from("invoices").select("id, number, status, handoff_order_id").in("handoff_order_id", handoffOrderIds).neq("status", "void");
  if (error) return {};
  return Object.fromEntries(((data ?? []) as Array<{ id: string; number: string | null; status: InvoiceStatus; handoff_order_id: string }>).map((r) => [r.handoff_order_id, r]));
}

/** Who the invoice comes from: the default billing business when there is one, else the company. Logo and colour
 * are the company's own branding (owner 2026-10-28: Taviron invoices carry the company's branding). */
export async function invoiceSender(inv: Invoice): Promise<{ name: string; addressLines: string[]; contactLine: string; logo: string; color: string }> {
  const { data } = await (await createClient()).from("company_settings")
    .select("company_name, address_line1, address_line2, city, state, postal_code, phone, email, brand_logo, brand_color").maybeSingle();
  const s = (data ?? {}) as Record<string, string | null>;
  const e = inv.issued_by_entity;
  const join = (...p: Array<string | null | undefined>) => p.filter((x) => x && String(x).trim()).join(" ");
  const city = (c?: string | null, st?: string | null, z?: string | null) => [c, join(st, z)].filter((x) => x && x.trim()).join(", ");
  const addressLines = e
    ? [e.address_line1, e.address_line2, city(e.city, e.region, e.postal_code)].filter((l) => l && l.trim())
    : [s.address_line1, s.address_line2, city(s.city, s.state, s.postal_code)].filter((l): l is string => Boolean(l && l.trim()));
  return {
    name: e?.name || s.company_name || "Company",
    addressLines,
    contactLine: [e?.phone || s.phone, e?.email || s.email].filter(Boolean).join(" · "),
    logo: /^data:image\/(png|jpeg);base64,/.test(s.brand_logo ?? "") ? (s.brand_logo as string) : "",
    color: /^#[0-9a-f]{6}$/i.test(s.brand_color ?? "") ? (s.brand_color as string) : "#1F2328",
  };
}
