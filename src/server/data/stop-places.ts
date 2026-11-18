import "server-only";
import { LOCATION_KINDS, type LocationKind } from "@/lib/routing/locations";
import type { StopPlace } from "@/lib/orders/stop-checks";
import { createClient } from "@/server/supabase/server";

// Places offered when typing a stop (owner 2026-11-16/17, WK3): the order's customer's job sites, then the company's
// saved locations (Route planner). Read with the person's own session: row-level security decides what is visible
// (customer sites need customers.view or quotes.view; saved locations dispatch.view or orders.view). Anything that
// cannot be read is simply not suggested; typing a place by hand always works.

export async function listStopPlaces(customerId: string | null): Promise<StopPlace[]> {
  const supabase = await createClient();
  const [sites, locations] = await Promise.all([
    customerId
      ? supabase.from("customer_sites").select("id, label, line1, city, state, postal_code").eq("customer_id", customerId).eq("active", true).order("label").limit(200)
      : Promise.resolve({ data: [], error: null }),
    supabase.from("company_locations").select("id, kind, name, address_line1, city, state, postal_code").eq("active", true).order("name").limit(300),
  ]);
  const out: StopPlace[] = [];
  for (const s of (sites.error ? [] : sites.data ?? []) as Array<{ id: string; label: string | null; line1: string | null; city: string | null; state: string | null; postal_code: string | null }>) {
    out.push({ key: `site:${s.id}`, group: "site", name: (s.label || s.line1 || "Job site").slice(0, 160), address_line1: s.line1 ?? "", city: s.city ?? "", state: s.state ?? "", postal_code: s.postal_code ?? "", label: "Customer site" });
  }
  for (const l of (locations.error ? [] : locations.data ?? []) as Array<{ id: string; kind: string; name: string; address_line1: string; city: string; state: string; postal_code: string }>) {
    out.push({ key: `location:${l.id}`, group: "location", name: l.name, address_line1: l.address_line1, city: l.city, state: l.state, postal_code: l.postal_code, label: LOCATION_KINDS[l.kind as LocationKind] ?? "Saved place" });
  }
  return out;
}
