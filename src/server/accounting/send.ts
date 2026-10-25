import "server-only";
import { buildQboInvoice, entitiesOf, qboDisplayName, qboDocNumber, snapshotTotals, totalDifference } from "@/lib/accounting/qbo";
import type { HandoffSnapshot } from "@/lib/billing/rules";
import { createInvoice, findInvoice, findOrCreateCustomer, QboReconnectError, type QboContext } from "@/server/accounting/qbo";
import { createClient } from "@/server/supabase/server";

// Send one billing-handoff order to QuickBooks (master plan B82, B89). Called only from a person pressing Send
// (billing.manage, checked again by every database function). An order split between businesses (for example materials
// from Top Line Stone & Sand, delivery from Top Line Trucking) becomes one invoice in each business's own QuickBooks.
// Each order and business is claimed first so it can never become two invoices: a sent one reports the existing
// invoice, a send in progress is not repeated, a retry of a timed-out request finds the invoice by number or reuses the
// request id. Demo companies never call QuickBooks: sends are recorded as simulated (docs/DEMO_TENANTS.md §2).

export interface SendResult { ok: boolean; message: string }

type Row = { order_id: string; snapshot: HandoffSnapshot; billing_handoffs: { batch_number: string } | null; orders: { customer_id: string } | null };

export async function sendHandoffOrder(handoffOrderId: string, opts: { isDemo: boolean }): Promise<SendResult> {
  const supabase = await createClient();
  const { data } = await supabase.from("billing_handoff_orders").select("order_id, snapshot, billing_handoffs(batch_number), orders(customer_id)").eq("id", handoffOrderId).maybeSingle();
  const row = data as unknown as Row | null;
  if (!row?.orders?.customer_id) return { ok: false, message: "The order or its customer could not be read." };
  const results: SendResult[] = [];
  for (const entity of entitiesOf(row.snapshot)) {
    const r = await sendOne(handoffOrderId, row, entity, opts);
    results.push(entity.name ? { ok: r.ok, message: `${entity.name}: ${r.message}` } : r);
  }
  return { ok: results.every((r) => r.ok), message: results.map((r) => r.message).join(" ") };
}

async function sendOne(handoffOrderId: string, row: Row, entity: { id: string | null; name: string | null }, opts: { isDemo: boolean }): Promise<SendResult> {
  const supabase = await createClient();
  const claim = await supabase.rpc("accounting_begin_send", { p_handoff_order: handoffOrderId, p_entity: entity.id, p_simulated: opts.isDemo });
  if (claim.error) return { ok: false, message: claim.error.message };
  const c = claim.data as { id: string; go: boolean; status?: string; number?: string; connection?: string | null };
  if (!c.go) return c.status === "sent" ? { ok: true, message: `Already in QuickBooks as invoice ${c.number}.` } : { ok: false, message: "Being sent right now. Try again in a few minutes." };

  const totals = snapshotTotals(row.snapshot, entity.id);
  const finish = (ok: boolean, extra: { id?: string; number?: string; qboTotal?: number | null; error?: string }) =>
    supabase.rpc("accounting_finish_send", {
      p_send: c.id, p_ok: ok, p_external_id: extra.id ?? null, p_external_number: extra.number ?? "",
      p_taviron_total: totals.total, p_qbo_total: extra.qboTotal ?? null, p_error: extra.error ?? "",
    });
  const docNumber = qboDocNumber(row.snapshot.order.order_number);

  if (opts.isDemo) {
    await finish(true, { id: `DEMO-${c.id.slice(0, 8)}`, number: docNumber, qboTotal: totals.total });
    return { ok: true, message: `Demo: simulated sending invoice ${docNumber} to QuickBooks. Nothing was sent.` };
  }

  try {
    const { data: conn } = await supabase.from("accounting_connections").select("id, realm_id, environment, item_id").eq("id", c.connection ?? "").maybeSingle();
    const k = conn as { id: string; realm_id: string; environment: "sandbox" | "production"; item_id: string | null } | null;
    if (!k?.item_id) throw new Error("Connect QuickBooks for this business and choose the product or service for invoice lines first.");
    const ctx: QboContext = { connectionId: k.id, realmId: k.realm_id, environment: k.environment };

    // The customer in this QuickBooks company: the saved link, or the customer with the same name, or a new one.
    const customerId = row.orders!.customer_id;
    const { data: link } = await supabase.from("accounting_customer_links").select("external_id").eq("connection_id", k.id).eq("customer_id", customerId).maybeSingle();
    let qboCustomer = (link as { external_id: string } | null)?.external_id ?? null;
    if (!qboCustomer) {
      const name = qboDisplayName(row.snapshot.order.customer_name || `Customer ${row.snapshot.order.customer_number ?? ""}`);
      const cust = await findOrCreateCustomer(ctx, name);
      qboCustomer = cust.id;
      await supabase.rpc("accounting_link_customer", { p_connection: k.id, p_customer: customerId, p_external_id: cust.id, p_external_name: cust.name, p_created: cust.created });
    }

    // Already there (an earlier attempt that timed out after QuickBooks created it): adopt it instead of a duplicate.
    const existing = await findInvoice(ctx, docNumber, qboCustomer);
    const invoice = existing ?? (await createInvoice(ctx, buildQboInvoice(row.snapshot, { customerId: qboCustomer, itemId: k.item_id }, row.billing_handoffs?.batch_number ?? "", entity.id), c.id));
    const qboTotal = Math.round(Number(invoice.TotalAmt) * 100);
    await finish(true, { id: invoice.Id, number: invoice.DocNumber ?? docNumber, qboTotal });
    const diff = totals.includesTax ? totalDifference(totals.total, qboTotal) : qboTotal < totals.total ? totalDifference(totals.total, qboTotal) : null;
    return { ok: true, message: `Sent as invoice ${invoice.DocNumber ?? docNumber}.${diff ? ` ${diff}` : ""}` };
  } catch (e) {
    const message = e instanceof Error ? e.message : "The send failed.";
    await finish(false, { error: message });
    if (e instanceof QboReconnectError && c.connection) await supabase.rpc("accounting_set_status", { p_connection: c.connection, p_status: "needs_reconnect" });
    return { ok: false, message };
  }
}
