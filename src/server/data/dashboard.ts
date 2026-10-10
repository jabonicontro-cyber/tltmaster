import "server-only";
import { createClient } from "@/server/supabase/server";
import { addDays } from "@/lib/dates";
import { isPastExpiration, needsFollowUp } from "@/lib/quotes/status";
import type { QuoteListRow } from "./types";

export interface DashboardFilters {
  from: string;
  to: string;
  customer?: string;
}

export interface QuoteMetric {
  count: number;
  totalCents: number;
}

function metric(rows: QuoteListRow[]): QuoteMetric {
  return { count: rows.length, totalCents: rows.reduce((s, r) => s + Number(r.total_cents), 0) };
}

/** All figures are computed from the quotes the signed-in user can see (RLS). */
export async function loadQuoteDashboard(filters: DashboardFilters, today: string, followupDays: number) {
  const supabase = await createClient();
  let open = supabase.from("quote_list").select("*").in("status", ["draft", "sent"]).order("valid_until");
  // Decided quotes in the period: accepted / declined dates are tracked on the quote.
  let decided = supabase
    .from("quotes")
    .select("id, status, accepted_at, closed_at, customer_id, quote_versions!quotes_current_version_fk(total_cents)")
    .in("status", ["accepted", "declined"])
    .or(`and(status.eq.accepted,accepted_at.gte.${filters.from},accepted_at.lt.${addDays(filters.to, 1)}),and(status.eq.declined,closed_at.gte.${filters.from},closed_at.lt.${addDays(filters.to, 1)})`);
  let recentAccepted = supabase.from("quote_list").select("*").eq("status", "accepted").gte("accepted_at", filters.from).lt("accepted_at", addDays(filters.to, 1)).order("accepted_at", { ascending: false }).limit(8);
  if (filters.customer) {
    open = open.eq("customer_id", filters.customer);
    decided = decided.eq("customer_id", filters.customer);
    recentAccepted = recentAccepted.eq("customer_id", filters.customer);
  }
  const [openRes, decidedRes, acceptedRes] = await Promise.all([open, decided, recentAccepted]);
  if (openRes.error || decidedRes.error || acceptedRes.error) {
    throw new Error(`Could not load dashboard: ${(openRes.error ?? decidedRes.error ?? acceptedRes.error)?.message}`);
  }
  const openRows = (openRes.data ?? []) as QuoteListRow[];
  const now = new Date();
  const drafts = openRows.filter((q) => q.status === "draft");
  const sent = openRows.filter((q) => q.status === "sent");
  const pastExpiration = sent.filter((q) => isPastExpiration(q.status, q.valid_until, today));
  const followUp = sent.filter((q) => !isPastExpiration(q.status, q.valid_until, today) && needsFollowUp(q.status, q.last_sent_at, now, followupDays));
  const expiringSoon = sent.filter((q) => q.valid_until >= today && q.valid_until <= addDays(today, 7));

  // PostgREST returns the to-one embed as an object; untyped clients see an array type.
  const decidedRows = (decidedRes.data ?? []) as unknown as Array<{ status: string; quote_versions: { total_cents: number } | { total_cents: number }[] | null }>;
  const totalOf = (r: (typeof decidedRows)[number]) => {
    const v = Array.isArray(r.quote_versions) ? r.quote_versions[0] : r.quote_versions;
    return Number(v?.total_cents ?? 0);
  };
  const accepted = decidedRows.filter((r) => r.status === "accepted");
  const declined = decidedRows.filter((r) => r.status === "declined");
  const decidedCount = accepted.length + declined.length;

  return {
    drafts: metric(drafts),
    awaiting: metric(sent),
    followUp,
    pastExpiration,
    expiringSoon,
    accepted: {
      count: accepted.length,
      totalCents: accepted.reduce((s, r) => s + totalOf(r), 0),
    },
    declinedCount: declined.length,
    // Only meaningful once there are decisions in the period.
    winRate: decidedCount > 0 ? Math.round((accepted.length / decidedCount) * 100) : null,
    recentAccepted: (acceptedRes.data ?? []) as QuoteListRow[],
    staleDrafts: drafts.filter((q) => q.updated_at < addDays(today, -7)),
  };
}
