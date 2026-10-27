import "server-only";
import { createClient } from "@/server/supabase/server";

// Job-site notes from customers (B94), read with the person's own session (customer access; RLS limits to the company).

export interface SiteNote {
  id: string;
  site_id: string;
  site: string;
  customer: string;
  current_directions: string;
  gate_code: string;
  drop_spot: string;
  contact_name: string;
  contact_phone: string;
  notes: string;
  submitted_at: string;
  photos: string[];
}

/** Pending notes, oldest first; null when the update is not installed. */
export async function pendingSiteNotes(): Promise<SiteNote[] | null> {
  const supabase = await createClient();
  const subs = await supabase.from("site_info_submissions").select("id, site_id, customer_id, gate_code, drop_spot, contact_name, contact_phone, notes, submitted_at").eq("status", "pending").order("submitted_at").limit(100);
  if (subs.error) {
    if (["42P01", "PGRST205"].includes(subs.error.code ?? "")) return null;
    throw new Error(`Could not load site notes: ${subs.error.message}`);
  }
  const rows = (subs.data ?? []) as Array<Omit<SiteNote, "site" | "customer" | "current_directions" | "photos"> & { customer_id: string }>;
  if (!rows.length) return [];
  const [sites, customers, photos] = await Promise.all([
    supabase.from("customer_sites").select("id, label, directions").in("id", [...new Set(rows.map((r) => r.site_id))]),
    supabase.from("customers").select("id, name").in("id", [...new Set(rows.map((r) => r.customer_id))]),
    supabase.from("site_photos").select("id, submission_id").in("submission_id", rows.map((r) => r.id)),
  ]);
  const site = new Map(((sites.data ?? []) as Array<{ id: string; label: string; directions: string }>).map((s) => [s.id, s]));
  const name = new Map(((customers.data ?? []) as Array<{ id: string; name: string }>).map((c) => [c.id, c.name]));
  const pics = (photos.data ?? []) as Array<{ id: string; submission_id: string }>;
  return rows.map((r) => ({
    ...r,
    site: site.get(r.site_id)?.label ?? "Job site",
    customer: name.get(r.customer_id) ?? "Customer",
    current_directions: site.get(r.site_id)?.directions ?? "",
    photos: pics.filter((p) => p.submission_id === r.id).map((p) => p.id),
  }));
}

/** The directions text proposed for review: the site's current directions with the customer's details added. */
export function proposedDirections(n: Pick<SiteNote, "current_directions" | "gate_code" | "drop_spot" | "contact_name" | "contact_phone" | "notes">): string {
  const added = [
    n.gate_code && `Gate code: ${n.gate_code}`,
    n.drop_spot && `Drop: ${n.drop_spot}`,
    (n.contact_name || n.contact_phone) && `Site contact: ${[n.contact_name, n.contact_phone].filter(Boolean).join(", ")}`,
    n.notes,
  ].filter(Boolean).join("\n");
  return [n.current_directions.trim(), added].filter(Boolean).join("\n\n").slice(0, 4000);
}
