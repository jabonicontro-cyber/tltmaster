import "server-only";
import { can, type Access } from "@/lib/permissions";
import { createClient } from "@/server/supabase/server";

// Billing businesses (20261120003400) and QuickBooks connections and sends (20261120003500), read as the person
// (billing.view, RLS). Before those database updates the loader says so instead of returning empty lists.

export interface BillingEntity {
  id: string; name: string; legal_name: string; address_line1: string; address_line2: string; city: string; region: string;
  postal_code: string; phone: string; email: string; invoice_prefix: string; is_default: boolean; active: boolean;
}
export interface AccountingConnection {
  id: string; billing_entity_id: string | null; environment: "sandbox" | "production"; realm_id: string; company_name: string;
  status: "connected" | "needs_reconnect"; item_id: string | null; item_name: string; connected_at: string;
}
export interface InvoiceSend {
  id: string; handoff_order_id: string; billing_entity_id: string | null; status: "sending" | "sent" | "failed"; simulated: boolean;
  external_number: string; taviron_total_cents: number | null; qbo_total_cents: number | null; attempts: number; last_error: string; sent_at: string | null;
}

const MISSING = new Set(["42P01", "PGRST205", "42883", "PGRST202"]);

export async function getAccountingSetup() {
  const supabase = await createClient();
  const [entities, rules, connections] = await Promise.all([
    supabase.from("billing_entities").select("*").order("is_default", { ascending: false }).order("name"),
    supabase.from("billing_entity_rules").select("charge_kind, entity_id"),
    supabase.from("accounting_connections").select("id, billing_entity_id, environment, realm_id, company_name, status, item_id, item_name, connected_at"),
  ]);
  return {
    entitiesInstalled: !(entities.error && MISSING.has(entities.error.code ?? "")),
    quickbooksInstalled: !(connections.error && MISSING.has(connections.error.code ?? "")),
    entities: (entities.data ?? []) as BillingEntity[],
    rules: Object.fromEntries(((rules.data ?? []) as Array<{ charge_kind: string; entity_id: string }>).map((r) => [r.charge_kind, r.entity_id])) as Record<string, string>,
    connections: (connections.data ?? []) as AccountingConnection[],
  };
}

/** QuickBooks sends for handed-off orders, by handoff order id. */
export async function getInvoiceSends(handoffOrderIds: string[]): Promise<Record<string, InvoiceSend[]>> {
  if (!handoffOrderIds.length) return {};
  const supabase = await createClient();
  const { data, error } = await supabase.from("accounting_invoice_sends").select("id, handoff_order_id, billing_entity_id, status, simulated, external_number, taviron_total_cents, qbo_total_cents, attempts, last_error, sent_at").in("handoff_order_id", handoffOrderIds);
  if (error) return {};
  const out: Record<string, InvoiceSend[]> = {};
  for (const s of (data ?? []) as InvoiceSend[]) (out[s.handoff_order_id] ??= []).push(s);
  return out;
}

/**
 * What the Handed off view needs for QuickBooks: whether Send is offered (billing.manage, the database update installed,
 * and a connected QuickBooks company; demo companies always, because their sends are simulated), the sends so far and
 * the business names. Sending itself is checked again by every database function.
 */
export async function getQuickBooksForHandoffs(handoffOrderIds: string[], access: Access) {
  const setup = await getAccountingSetup();
  const canSend = can(access, "billing.manage") && setup.quickbooksInstalled && (Boolean(access.isDemo) || setup.connections.some((c) => c.status === "connected"));
  return {
    canSend,
    shown: setup.quickbooksInstalled && (canSend || setup.connections.length > 0),
    sends: setup.quickbooksInstalled ? await getInvoiceSends(handoffOrderIds) : {},
    entityNames: Object.fromEntries(setup.entities.map((e) => [e.id, e.name])) as Record<string, string>,
  };
}
