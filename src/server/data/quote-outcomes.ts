import "server-only";
import { quoteOutcomes, type DecidedQuote, type QuoteOutcomes } from "@/lib/quotes/outcomes";
import { straightLineMiles } from "@/lib/routing/route";
import { getSettings } from "@/server/data/settings";
import { createClient } from "@/server/supabase/server";
import { addDays, todayIn, zonedTimeToUtc } from "@/lib/dates";

// Quote win/loss (B95), read with the person's own session: RLS limits it to their company and to people who can see
// quotes. Decided quotes only: accepted (won), declined or expired (lost), by the day they were decided. Canceled quotes
// were withdrawn by the company and are left out.

export async function loadQuoteOutcomes(from: string, to: string, timeZone: string): Promise<QuoteOutcomes> {
  const supabase = await createClient();
  // The period's days are the company's own calendar days, not UTC ones (an evening decision belongs to that day).
  const start = zonedTimeToUtc(from, "00:00", timeZone)!;
  const end = zonedTimeToUtc(addDays(to, 1), "00:00", timeZone)!;
  const quotes = await supabase
    .from("quotes")
    .select("id, quote_number, status, customer_id, current_version_id, accepted_version_id, first_sent_at, accepted_at, closed_at, status_note")
    .in("status", ["accepted", "declined", "expired"])
    .or(`and(accepted_at.gte.${start},accepted_at.lt.${end}),and(closed_at.gte.${start},closed_at.lt.${end})`)
    .limit(2000);
  if (quotes.error) throw new Error(`Could not load quotes: ${quotes.error.message}`);
  type Row = { id: string; quote_number: string; status: string; customer_id: string; current_version_id: string | null; accepted_version_id: string | null; first_sent_at: string | null; accepted_at: string | null; closed_at: string | null; status_note: string };
  const rows = ((quotes.data ?? []) as Row[]).filter((q) => (q.status === "accepted" ? q.accepted_at : q.closed_at));
  if (!rows.length) return quoteOutcomes([]);

  const versionIds = rows.map((q) => q.accepted_version_id ?? q.current_version_id).filter((v): v is string => Boolean(v));
  const [versions, lines, customers, settings] = await Promise.all([
    supabase.from("quote_versions").select("id, site_id, total_cents").in("id", versionIds),
    supabase.from("quote_lines").select("quote_version_id, unit_code, unit_rate_cents, material:materials(name), item:charge_items(name)").in("quote_version_id", versionIds).eq("calc_method", "per_unit"),
    supabase.from("customers").select("id, name").in("id", [...new Set(rows.map((q) => q.customer_id))]),
    getSettings(),
  ]);
  for (const r of [versions, lines, customers]) if (r.error) throw new Error(`Could not load quotes: ${r.error.message}`);
  const versionRows = (versions.data ?? []) as Array<{ id: string; site_id: string | null; total_cents: number }>;
  const siteIds = [...new Set(versionRows.map((v) => v.site_id).filter((s): s is string => Boolean(s)))];
  const sites = siteIds.length ? await supabase.from("customer_sites").select("id, latitude, longitude").in("id", siteIds) : { data: [] };
  const sitePoint = new Map(((sites.data ?? []) as Array<{ id: string; latitude: number | string | null; longitude: number | string | null }>).filter((s) => s.latitude != null && s.longitude != null).map((s) => [s.id, { lat: Number(s.latitude), lng: Number(s.longitude) }]));
  const y = settings as unknown as { yard_latitude?: number | string | null; yard_longitude?: number | string | null };
  const yard = y.yard_latitude != null && y.yard_longitude != null ? { lat: Number(y.yard_latitude), lng: Number(y.yard_longitude) } : null;

  const versionById = new Map(versionRows.map((v) => [v.id, v]));
  const customerName = new Map(((customers.data ?? []) as Array<{ id: string; name: string }>).map((c) => [c.id, c.name]));
  const linesByVersion = new Map<string, DecidedQuote["materials"]>();
  // Priced items: a material, or a catalog charge such as hauling (haulers without materials quote those).
  for (const l of (lines.data ?? []) as unknown as Array<{ quote_version_id: string; unit_code: string; unit_rate_cents: number; material: { name: string } | null; item: { name: string } | null }>) {
    const name = l.material?.name ?? l.item?.name;
    if (!name) continue;
    linesByVersion.set(l.quote_version_id, [...(linesByVersion.get(l.quote_version_id) ?? []), { name, unit: l.unit_code, rateCents: Number(l.unit_rate_cents) }]);
  }

  return quoteOutcomes(
    rows.map((q) => {
      const vid = q.accepted_version_id ?? q.current_version_id ?? "";
      const v = versionById.get(vid);
      const site = v?.site_id ? sitePoint.get(v.site_id) : undefined;
      const decided = (q.status === "accepted" ? q.accepted_at : q.closed_at)!;
      return {
        id: q.id,
        number: q.quote_number,
        outcome: q.status === "accepted" ? "won" : "lost",
        status: q.status,
        customer: customerName.get(q.customer_id) ?? "Customer",
        decidedOn: todayIn(timeZone, new Date(decided)),
        firstSentOn: q.first_sent_at ? todayIn(timeZone, new Date(q.first_sent_at)) : null,
        miles: yard && site ? straightLineMiles(yard, site) : null,
        reason: q.status === "accepted" ? "" : q.status_note ?? "",
        totalCents: Number(v?.total_cents ?? 0),
        materials: linesByVersion.get(vid) ?? [],
      } satisfies DecidedQuote;
    }),
  );
}
