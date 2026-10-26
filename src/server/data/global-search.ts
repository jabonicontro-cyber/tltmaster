import "server-only";
import type { Access } from "@/lib/permissions";
import { ilikePattern, referenceKey, searchableGroups, type SearchGroupKey, type SearchHit } from "@/lib/search";
import { idsClause, REF_KEYS, referenceMatches } from "@/server/data/search";
import { WO_STATUSES, type WoStatus } from "@/lib/maintenance";
import { ORDER_STATUS_LABELS } from "@/lib/orders/status";
import type { OrderStatus } from "@/server/data/types";
import { QUOTE_STATUS_LABELS, type QuoteStatus } from "@/lib/quotes/status";
import { TICKET_STATUS_LABELS, type TicketStatus } from "@/lib/tickets/rules";
import { createClient } from "@/server/supabase/server";

const LIMIT = 6;

/**
 * Search the records this person may open. Every query runs with their own session, so row-level security keeps it
 * inside their company (and their dispatch bases); groups their role cannot open are not queried at all.
 */
export async function globalSearch(access: Access, q: string, limit = LIMIT): Promise<Array<{ key: SearchGroupKey; label: string; hits: SearchHit[] }>> {
  const supabase = await createClient();
  const like = ilikePattern(q);
  const ref = referenceKey(q);
  const groups = searchableGroups(access.permissions);
  const run = async (key: SearchGroupKey): Promise<SearchHit[]> => {
    switch (key) {
      case "customers": {
        const { data } = await supabase.from("customers").select("id, name, customer_number, email").or(`name.ilike.${like},customer_number.ilike.${like},email.ilike.${like}${idsClause(await referenceMatches(supabase, REF_KEYS.customers, ref))}`).order("name").limit(limit);
        return ((data ?? []) as Array<{ id: string; name: string; customer_number: string; email: string }>).map((r) => ({ id: r.id, title: r.name, detail: [r.customer_number, r.email].filter(Boolean).join(" · "), href: `/customers/${r.id}` }));
      }
      case "orders": {
        const { data } = await supabase.from("order_list").select("id, order_number, customer_name, project_name, customer_po, status").or(`order_number.ilike.${like},customer_name.ilike.${like},project_name.ilike.${like},customer_po.ilike.${like}${idsClause(await referenceMatches(supabase, REF_KEYS.orders, ref))}`).order("created_at", { ascending: false }).limit(limit);
        return ((data ?? []) as Array<{ id: string; order_number: string; customer_name: string; project_name: string; customer_po: string; status: string }>).map((r) => ({ id: r.id, title: `Order ${r.order_number}`, detail: [r.customer_name, r.project_name, r.customer_po ? `PO ${r.customer_po}` : "", ORDER_STATUS_LABELS[r.status as OrderStatus] ?? r.status].filter(Boolean).join(" · "), href: `/orders/${r.id}` }));
      }
      case "quotes": {
        const { data } = await supabase.from("quote_list").select("id, quote_number, customer_name, project_name, status").or(`quote_number.ilike.${like},customer_name.ilike.${like},project_name.ilike.${like}${idsClause(await referenceMatches(supabase, REF_KEYS.quotes, ref))}`).order("created_at", { ascending: false }).limit(limit);
        return ((data ?? []) as Array<{ id: string; quote_number: string; customer_name: string; project_name: string; status: string }>).map((r) => ({ id: r.id, title: `Quote ${r.quote_number}`, detail: [r.customer_name, r.project_name, QUOTE_STATUS_LABELS[r.status as QuoteStatus] ?? r.status].filter(Boolean).join(" · "), href: `/quotes/${r.id}` }));
      }
      case "tickets": {
        const { data } = await supabase.from("delivery_tickets").select("id, ticket_number, external_reference, delivered_at, status").or(`ticket_number.ilike.${like},external_reference.ilike.${like}${idsClause(await referenceMatches(supabase, REF_KEYS.tickets, ref))}`).neq("status", "superseded").order("delivered_at", { ascending: false }).limit(limit);
        return ((data ?? []) as Array<{ id: string; ticket_number: string; external_reference: string; delivered_at: string; status: string }>).map((r) => ({ id: r.id, title: `Ticket ${r.ticket_number}`, detail: [r.external_reference, r.delivered_at?.slice(0, 10), TICKET_STATUS_LABELS[r.status as TicketStatus] ?? r.status].filter(Boolean).join(" · "), href: `/tickets/${r.id}` }));
      }
      case "workOrders": {
        const { data } = await supabase.from("work_orders").select("id, number, title, status").or(`number.ilike.${like},title.ilike.${like}${idsClause(await referenceMatches(supabase, REF_KEYS.workOrders, ref))}`).order("created_at", { ascending: false }).limit(limit);
        return ((data ?? []) as Array<{ id: string; number: string; title: string; status: string }>).map((r) => ({ id: r.id, title: `Work order ${r.number}`, detail: [r.title, WO_STATUSES[r.status as WoStatus] ?? r.status].filter(Boolean).join(" · "), href: `/maintenance/work-orders/${r.id}` }));
      }
      case "trucks": {
        const { data } = await supabase.from("trucks").select("id, unit_number, active").ilike("unit_number", like).order("unit_number").limit(limit);
        return ((data ?? []) as Array<{ id: string; unit_number: string; active: boolean }>).map((r) => ({ id: r.id, title: `Truck ${r.unit_number}`, detail: r.active ? "" : "Inactive", href: `/fleet/trucks/${r.id}` }));
      }
      case "trailers": {
        const { data } = await supabase.from("trailers").select("id, unit_number, active").ilike("unit_number", like).order("unit_number").limit(limit);
        return ((data ?? []) as Array<{ id: string; unit_number: string; active: boolean }>).map((r) => ({ id: r.id, title: `Trailer ${r.unit_number}`, detail: r.active ? "" : "Inactive", href: `/fleet/trailers/${r.id}` }));
      }
      case "drivers": {
        const { data } = await supabase.from("drivers").select("id, name, employee_number, active").or(`name.ilike.${like},employee_number.ilike.${like}`).order("name").limit(limit);
        return ((data ?? []) as Array<{ id: string; name: string; employee_number: string; active: boolean }>).map((r) => ({ id: r.id, title: r.name, detail: [r.employee_number, r.active ? "" : "Inactive"].filter(Boolean).join(" · "), href: `/fleet/drivers/${r.id}` }));
      }
      case "people": {
        const { data } = await supabase.from("employees").select("id, full_name, job_title, status").or(`full_name.ilike.${like},job_title.ilike.${like}`).order("full_name").limit(limit);
        return ((data ?? []) as Array<{ id: string; full_name: string; job_title: string; status: string }>).map((r) => ({ id: r.id, title: r.full_name, detail: [r.job_title, r.status].filter(Boolean).join(" · "), href: `/employees/${r.id}` }));
      }
    }
  };
  const results = await Promise.all(groups.map(async (g) => ({ key: g.key, label: g.label, hits: await run(g.key).catch(() => []) })));
  return results.filter((r) => r.hits.length);
}
