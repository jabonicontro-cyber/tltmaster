import "server-only";
import { uuid } from "@/lib/schemas/common";
import type { SupportKind, SupportStatus } from "@/lib/support";
import { createClient } from "@/server/supabase/server";

// Support center (B138, 20261120006800). Reads go through RLS (customers.view); writes through the support_* functions.

const MISSING = new Set(["42P01", "42703", "PGRST204", "PGRST205"]);

export type SupportCaseRow = {
  id: string; customer_id: string; customer_name: string; subject: string; kind: SupportKind; status: SupportStatus;
  assigned_to: string | null; created_at: string; updated_at: string; first_reply_at: string | null; closed_at: string | null;
  from_portal: boolean;
};
export type SupportFilter = "open" | "mine" | "unassigned" | "closed" | "all";

export async function listSupportCases(filter: SupportFilter, userId: string): Promise<{ installed: boolean; cases: SupportCaseRow[] }> {
  const supabase = await createClient();
  let q = supabase.from("portal_support_requests")
    .select("id, customer_id, subject, kind, status, assigned_to, created_at, updated_at, first_reply_at, closed_at, account_id, customers(name)")
    .order("updated_at", { ascending: false }).limit(200);
  if (filter === "open") q = q.neq("status", "closed");
  if (filter === "closed") q = q.eq("status", "closed");
  if (filter === "mine") q = q.eq("assigned_to", userId).neq("status", "closed");
  if (filter === "unassigned") q = q.is("assigned_to", null).neq("status", "closed");
  const { data, error } = await q;
  if (error) {
    if (MISSING.has(error.code ?? "")) return { installed: false, cases: [] };
    throw new Error(`Could not load support cases: ${error.message}`);
  }
  return {
    installed: true,
    cases: ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
      id: String(r.id), customer_id: String(r.customer_id), customer_name: (r.customers as { name?: string } | null)?.name ?? "Customer",
      subject: String(r.subject), kind: r.kind as SupportKind, status: r.status as SupportStatus, assigned_to: (r.assigned_to as string | null) ?? null,
      created_at: String(r.created_at), updated_at: String(r.updated_at), first_reply_at: (r.first_reply_at as string | null) ?? null,
      closed_at: (r.closed_at as string | null) ?? null, from_portal: r.account_id !== null,
    })),
  };
}

export type SupportMessage = { id: string; author_kind: "customer" | "staff"; author_id: string | null; body: string; internal: boolean; created_at: string; files: Array<{ id: string; name: string; type: string }> };
export type SupportCase = SupportCaseRow & {
  order: { id: string; number: string } | null; ticket: { id: string; number: string } | null; invoice: { id: string; number: string } | null;
  messages: SupportMessage[];
};

export async function getSupportCase(id: string): Promise<SupportCase | null> {
  if (!uuid.safeParse(id).success) return null;
  const supabase = await createClient();
  const { data: r, error } = await supabase.from("portal_support_requests")
    .select("id, customer_id, subject, kind, status, assigned_to, created_at, updated_at, first_reply_at, closed_at, account_id, order_id, ticket_id, invoice_id, customers(name)")
    .eq("id", id).maybeSingle();
  if (error || !r) return null;
  const row = r as Record<string, unknown>;
  const [msgs, files, order, ticket, invoice] = await Promise.all([
    supabase.from("portal_messages").select("id, author_kind, author_id, body, internal, created_at").eq("request_id", id).order("created_at"),
    supabase.from("portal_support_files").select("id, message_id, file_name, mime_type").eq("request_id", id).order("created_at"),
    row.order_id ? supabase.from("orders").select("id, order_number").eq("id", row.order_id as string).maybeSingle() : Promise.resolve({ data: null }),
    row.ticket_id ? supabase.from("delivery_tickets").select("id, ticket_number").eq("id", row.ticket_id as string).maybeSingle() : Promise.resolve({ data: null }),
    row.invoice_id ? supabase.from("invoices").select("id, number").eq("id", row.invoice_id as string).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  const byMessage = new Map<string, Array<{ id: string; name: string; type: string }>>();
  for (const f of (files.data ?? []) as Array<{ id: string; message_id: string; file_name: string; mime_type: string }>) {
    byMessage.set(f.message_id, [...(byMessage.get(f.message_id) ?? []), { id: f.id, name: f.file_name, type: f.mime_type }]);
  }
  const o = order.data as { id: string; order_number: string } | null;
  const t = ticket.data as { id: string; ticket_number: string } | null;
  const i = invoice.data as { id: string; number: string } | null;
  return {
    id: String(row.id), customer_id: String(row.customer_id), customer_name: (row.customers as { name?: string } | null)?.name ?? "Customer",
    subject: String(row.subject), kind: row.kind as SupportKind, status: row.status as SupportStatus, assigned_to: (row.assigned_to as string | null) ?? null,
    created_at: String(row.created_at), updated_at: String(row.updated_at), first_reply_at: (row.first_reply_at as string | null) ?? null,
    closed_at: (row.closed_at as string | null) ?? null, from_portal: row.account_id !== null,
    order: o ? { id: o.id, number: o.order_number } : null, ticket: t ? { id: t.id, number: t.ticket_number } : null, invoice: i ? { id: i.id, number: i.number } : null,
    messages: ((msgs.data ?? []) as Array<Omit<SupportMessage, "files">>).map((m) => ({ ...m, files: byMessage.get(m.id) ?? [] })),
  };
}

/** The customer's orders, tickets and invoices to link a case to (most recent first). */
export async function supportLinkOptions(customerId: string) {
  const supabase = await createClient();
  const [orders, invoices] = await Promise.all([
    supabase.from("orders").select("id, order_number").eq("customer_id", customerId).neq("status", "draft").order("created_at", { ascending: false }).limit(50),
    supabase.from("invoices").select("id, number").eq("customer_id", customerId).neq("status", "draft").order("created_at", { ascending: false }).limit(50),
  ]);
  const orderRows = (orders.data ?? []) as Array<{ id: string; order_number: string }>;
  const tickets = orderRows.length
    ? await supabase.from("delivery_tickets").select("id, ticket_number").in("order_id", orderRows.map((o) => o.id)).neq("status", "superseded").order("created_at", { ascending: false }).limit(50)
    : { data: [] };
  return {
    orders: orderRows.map((o) => ({ id: o.id, label: o.order_number })),
    tickets: ((tickets.data ?? []) as Array<{ id: string; ticket_number: string }>).map((t) => ({ id: t.id, label: t.ticket_number })),
    invoices: ((invoices.error ? [] : invoices.data ?? []) as Array<{ id: string; number: string }>).map((i) => ({ id: i.id, label: i.number })),
  };
}

/** The company's first-reply target and how many cases wait past it (none before the update or when unset). */
export async function supportOverdue(): Promise<{ targetHours: number | null; count: number; oldest: string | null }> {
  const { data, error } = await (await createClient()).rpc("support_overdue");
  if (error) return { targetHours: null, count: 0, oldest: null };
  const r = data as { target_hours: number | null; count: number; oldest: string | null };
  return { targetHours: r.target_hours, count: Number(r.count ?? 0), oldest: r.oldest };
}
