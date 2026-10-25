import "server-only";
import { buildQboInvoice, qboDisplayName, qboDocNumber, snapshotTotals, totalDifference } from "@/lib/accounting/qbo";
import type { HandoffSnapshot } from "@/lib/billing/rules";
import { createInvoice, findInvoice, findOrCreateCustomer, QboReconnectError, type QboContext } from "@/server/accounting/qbo";
import { createClient } from "@/server/supabase/server";

// Send one billing-handoff order to QuickBooks as one invoice (master plan B82). Called only from a person pressing
// Send (billing.manage, checked again by every database function). The order is claimed first so it can never become
// two QuickBooks invoices: a sent order reports the existing invoice, a send in progress is not repeated, a retry of
// a timed-out request finds the invoice by number or reuses the request id. Demo companies never call QuickBooks:
// the send is recorded as simulated (docs/DEMO_TENANTS.md §2).

export interface SendResult { ok: boolean; message: string }

export async function sendHandoffOrder(handoffOrderId: string, opts: { isDemo: boolean }): Promise<SendResult> {
  const supabase = await createClient();
  const claim = await supabase.rpc("accounting_begin_send", { p_handoff_order: handoffOrderId, p_simulated: opts.isDemo });
  if (claim.error) return { ok: false, message: claim.error.message };
  const c = claim.data as { id: string; go: boolean; status?: string; number?: string };
  if (!c.go) return c.status === "sent" ? { ok: true, message: `Already in QuickBooks as invoice ${c.number}.` } : { ok: false, message: "This order is being sent right now. Try again in a few minutes." };

  const finish = (ok: boolean, extra: { id?: string; number?: string; tavironTotal?: number; qboTotal?: number | null; error?: string }) =>
    supabase.rpc("accounting_finish_send", {
      p_send: c.id, p_ok: ok, p_external_id: extra.id ?? null, p_external_number: extra.number ?? "",
      p_taviron_total: extra.tavironTotal ?? null, p_qbo_total: extra.qboTotal ?? null, p_error: extra.error ?? "",
    });

  const { data: row } = await supabase.from("billing_handoff_orders").select("order_id, snapshot, billing_handoffs(batch_number), orders(customer_id)").eq("id", handoffOrderId).maybeSingle();
  const r = row as unknown as { order_id: string; snapshot: HandoffSnapshot; billing_handoffs: { batch_number: string } | null; orders: { customer_id: string } | null } | null;
  if (!r?.orders?.customer_id) {
    await finish(false, { error: "The order or its customer could not be read." });
    return { ok: false, message: "The order or its customer could not be read." };
  }
  const totals = snapshotTotals(r.snapshot);

  if (opts.isDemo) {
    const number = qboDocNumber(r.snapshot.order.order_number);
    await finish(true, { id: `DEMO-${handoffOrderId.slice(0, 8)}`, number, tavironTotal: totals.total, qboTotal: totals.total });
    return { ok: true, message: `Demo: simulated sending invoice ${number} to QuickBooks. Nothing was sent.` };
  }

  try {
    const { data: conn } = await supabase.from("accounting_connections").select("company_id, realm_id, environment, item_id").maybeSingle();
    const k = conn as { company_id: string; realm_id: string; environment: "sandbox" | "production"; item_id: string | null } | null;
    if (!k?.item_id) throw new Error("Connect QuickBooks and choose the product or service for invoice lines first.");
    const ctx: QboContext = { companyId: k.company_id, realmId: k.realm_id, environment: k.environment };

    // The customer: the saved link, or the QuickBooks customer with the same name, or a new one (and remember it).
    const { data: link } = await supabase.from("accounting_customer_links").select("external_id").eq("customer_id", r.orders.customer_id).maybeSingle();
    let customerId = (link as { external_id: string } | null)?.external_id ?? null;
    if (!customerId) {
      const name = qboDisplayName(r.snapshot.order.customer_name || `Customer ${r.snapshot.order.customer_number ?? ""}`);
      const cust = await findOrCreateCustomer(ctx, name);
      customerId = cust.id;
      await supabase.rpc("accounting_link_customer", { p_customer: r.orders.customer_id, p_external_id: cust.id, p_external_name: cust.name, p_created: cust.created });
    }

    // Already there (an earlier attempt that timed out after QuickBooks created it): adopt it instead of a duplicate.
    const docNumber = qboDocNumber(r.snapshot.order.order_number);
    const existing = await findInvoice(ctx, docNumber, customerId);
    const invoice = existing ?? (await createInvoice(ctx, buildQboInvoice(r.snapshot, { customerId, itemId: k.item_id }, r.billing_handoffs?.batch_number ?? ""), c.id));
    const qboTotal = Math.round(Number(invoice.TotalAmt) * 100);
    await finish(true, { id: invoice.Id, number: invoice.DocNumber ?? docNumber, tavironTotal: totals.total, qboTotal });
    const diff = totalDifference(totals.total, qboTotal);
    return { ok: true, message: `Sent to QuickBooks as invoice ${invoice.DocNumber ?? docNumber}.${diff ? ` ${diff}` : ""}` };
  } catch (e) {
    const message = e instanceof Error ? e.message : "The send failed.";
    await finish(false, { tavironTotal: totals.total, error: message });
    if (e instanceof QboReconnectError) await supabase.rpc("accounting_set_status", { p_status: "needs_reconnect" });
    return { ok: false, message };
  }
}
