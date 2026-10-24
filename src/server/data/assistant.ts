import "server-only";
import type { ExceptionKind } from "@/lib/command-center/rules";
import type { Access } from "@/lib/permissions";
import { can } from "@/lib/permissions";
import { referenceKey } from "@/lib/search";
import type { AssistantOrder, AssistantReport, AssistantSource } from "@/server/ai/assistant";
import { loadQueue, loadSummary } from "@/server/data/command-center";
import { loadOutlook } from "@/server/data/live";
import { listOpenWorkOrders, listPmStatus, listTrailers, listTrucks, trailerWorkOrdersAvailable } from "@/server/data/maintenance";
import { createClient } from "@/server/supabase/server";

// What "Ask Taviron" reads (docs/AI.md §12): the same services the pages use, through the caller's own session, so
// row-level security and each service's permission checks decide what is visible. Failures read as "unavailable",
// never as an empty result.

const NAME_LIMIT = 2000;

interface RawReport {
  from: string;
  to: string;
  deliveries?: { tickets: number; accepted: number; pending: number; voided: number; corrected: number; median_hours_to_accept: number | null };
  value?: { verified_value_cents: number; priced_tickets: number; unpriced_tickets: number };
  billing?: { handed_off_orders: number; ready_not_handed_off: number; loads_missing_tickets: number; orders_with_missing_tickets: number };
  fleet?: Array<{ loads: number; days_with_loads: number; days_out_of_service: number }>;
}

/** The report's totals only; ranked lists (customer names, unit numbers) are left out. */
export function reportTotals(r: RawReport): AssistantReport {
  const n = (v: unknown) => Number(v ?? 0);
  return {
    from: String(r.from),
    to: String(r.to),
    deliveries: r.deliveries ? {
      tickets: n(r.deliveries.tickets), accepted: n(r.deliveries.accepted), pending: n(r.deliveries.pending), voided: n(r.deliveries.voided),
      corrected: n(r.deliveries.corrected), medianHoursToAccept: r.deliveries.median_hours_to_accept === null ? null : n(r.deliveries.median_hours_to_accept),
    } : null,
    value: r.value ? { acceptedTicketValueUsd: Math.round(n(r.value.verified_value_cents)) / 100, pricedTickets: n(r.value.priced_tickets), unpricedTickets: n(r.value.unpriced_tickets) } : null,
    billing: r.billing ? { readyNotHandedOff: n(r.billing.ready_not_handed_off), loadsMissingTickets: n(r.billing.loads_missing_tickets), ordersWithMissingTickets: n(r.billing.orders_with_missing_tickets), handedOffOrders: n(r.billing.handed_off_orders) } : null,
    fleet: r.fleet ? {
      trucks: r.fleet.length,
      loads: r.fleet.reduce((a, t) => a + n(t.loads), 0),
      daysWithLoads: r.fleet.reduce((a, t) => a + n(t.days_with_loads), 0),
      daysOutOfService: r.fleet.reduce((a, t) => a + n(t.days_out_of_service), 0),
    } : null,
  };
}

export function sessionAssistantSource(access: Pick<Access, "permissions">, today: string): AssistantSource {
  const may = (p: Parameters<typeof can>[1]) => can(access, p);
  return {
    async summary() {
      const s = await loadSummary();
      return s.ok ? s.data : null;
    },

    async queue(kind: ExceptionKind | null, limit: number) {
      const q = await loadQueue({ kind: kind ?? undefined, page: 1, limit });
      return q.ok ? q.data.items : null;
    },

    async order(lookup) {
      if (!may("orders.view")) return null;
      const supabase = await createClient();
      const base = supabase.from("orders").select("id, order_number, status, requested_date, customer_id");
      let row: Record<string, unknown> | null = null;
      if ("id" in lookup) {
        row = (await base.eq("id", lookup.id).maybeSingle()).data as Record<string, unknown> | null;
      } else {
        const key = referenceKey(lookup.reference);
        const byKey = key ? await base.eq("order_ref_key", key).limit(2) : null;
        // Before the reference-number update (20261120001300) there is no search key: match the stored number exactly.
        const rows = byKey && !byKey.error ? byKey.data : (await supabase.from("orders").select("id, order_number, status, requested_date, customer_id").eq("order_number", lookup.reference).limit(2)).data;
        // Two matches would be ambiguous; within one company references are unique, so this means nothing is shown.
        row = rows && rows.length === 1 ? (rows[0] as Record<string, unknown>) : null;
      }
      if (!row) return null;
      const id = String(row.id);
      const [customer, loads, fulfillment, billing] = await Promise.all([
        may("customers.view") ? supabase.from("customers").select("id, name").eq("id", String(row.customer_id)).maybeSingle() : Promise.resolve({ data: null }),
        supabase.from("order_loads").select("status").eq("order_id", id).limit(1000),
        supabase.from("order_fulfillment").select("loads_planned, loads_upcoming, loads_without_accepted_ticket, tickets_pending, tickets_accepted, fulfilled").eq("order_id", id).maybeSingle(),
        may("billing.view") ? supabase.from("billing_order_status").select("readiness, exceptions_count, handoff_id").eq("order_id", id).maybeSingle() : Promise.resolve({ data: null }),
      ]);
      const counts: Record<string, number> = {};
      for (const l of (loads.data ?? []) as Array<{ status: string }>) counts[l.status] = (counts[l.status] ?? 0) + 1;
      const f = fulfillment.data as Record<string, unknown> | null;
      const b = billing.data as Record<string, unknown> | null;
      const c = customer.data as { id: string; name: string } | null;
      const out: AssistantOrder = {
        id,
        number: String(row.order_number),
        status: String(row.status),
        requestedDate: (row.requested_date as string | null) ?? null,
        customer: c,
        loads: counts,
        fulfillment: f ? {
          loadsPlanned: Number(f.loads_planned), loadsUpcoming: Number(f.loads_upcoming), loadsWithoutAcceptedTicket: Number(f.loads_without_accepted_ticket),
          ticketsPending: Number(f.tickets_pending), ticketsAccepted: Number(f.tickets_accepted), fulfilled: Boolean(f.fulfilled),
        } : null,
        billing: b ? { readiness: String(b.readiness), exceptions: Number(b.exceptions_count ?? 0), handedOff: b.handoff_id !== null } : null,
      };
      return out;
    },

    async maintenance() {
      if (!may("maintenance.view")) return null;
      try {
        const [wos, pm, trucks, trailersOk] = await Promise.all([listOpenWorkOrders(), listPmStatus(), listTrucks(), trailerWorkOrdersAvailable()]);
        const trailers = trailersOk ? await listTrailers() : [];
        const truckNo = new Map(trucks.map((t) => [t.id, t.unit_number]));
        const trailerNo = new Map(trailers.map((t) => [t.id, t.unit_number]));
        return {
          workOrders: wos
            .sort((a, b) => Number(b.safety_critical) - Number(a.safety_critical) || a.created_at.localeCompare(b.created_at))
            .map((w) => ({
              id: w.id,
              number: w.number,
              unit: w.truck_id && truckNo.has(w.truck_id) ? { kind: "truck" as const, id: w.truck_id, number: truckNo.get(w.truck_id)! }
                : w.trailer_id && trailerNo.has(w.trailer_id) ? { kind: "trailer" as const, id: w.trailer_id, number: trailerNo.get(w.trailer_id)! } : null,
              status: w.status,
              urgency: w.urgency,
              safetyCritical: w.safety_critical,
              dueOn: w.due_on,
            })),
          pm: pm.map((x) => ({ truckId: x.truck_id, unitNumber: x.unit_number, state: x.state, nextDueOn: x.next_due_on, readingsStale: x.readings_stale })),
        };
      } catch {
        return null;
      }
    },

    async outlook() {
      if (!may("dispatch.view")) return null;
      try {
        return (await loadOutlook(today, false)).days;
      } catch {
        return null;
      }
    },

    async report(from, to) {
      const supabase = await createClient();
      const { data, error } = await supabase.rpc("report_operations", { p_from: from, p_to: to });
      if (error || !data) return null;
      return reportTotals(data as RawReport);
    },

    async names() {
      const supabase = await createClient();
      const [customers, drivers] = await Promise.all([
        may("customers.view") ? supabase.from("customers").select("id, name").limit(NAME_LIMIT) : Promise.resolve({ data: [] }),
        supabase.from("employees").select("id, full_name").limit(NAME_LIMIT),
      ]);
      return [
        ...((customers.data ?? []) as Array<{ id: string; name: string }>).map((c) => ({ kind: "customer" as const, key: c.id, label: c.name, href: `/customers/${c.id}` })),
        ...((drivers.data ?? []) as Array<{ id: string; full_name: string }>).map((d) => ({ kind: "driver" as const, key: d.id, label: d.full_name, href: null })),
      ];
    },
  };
}
