import "server-only";
import { billingReadySpeed, planningSpeed, reviewPace, type BillingReadySpeed, type PlanningSpeed, type ReviewPace } from "@/lib/command-center/speed";
import { createClient } from "@/server/supabase/server";

// Speed metrics (B86) over the last 30 days, read with the person's own session: RLS keeps them to the person's company
// (and bases), and each figure is loaded only for a role that sees its records.

export const SPEED_DAYS = 30;
const PAGE = 1000;
const MAX_PAGES = 10;

export interface SpeedMetrics {
  planning: PlanningSpeed | null | undefined;
  billingReady: BillingReadySpeed | null | undefined;
  pace: ReviewPace | null | undefined;
}

/** Every row of a query, a page at a time (the API returns at most 1000 per request). */
async function all<T>(page: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const rows: T[] = [];
  for (let i = 0; i < MAX_PAGES; i++) {
    const { data, error } = await page(i * PAGE, i * PAGE + PAGE - 1);
    if (error) throw new Error(error.message);
    const batch = (data ?? []) as T[];
    rows.push(...batch);
    if (batch.length < PAGE) break;
  }
  return rows;
}

/** `undefined` means the person cannot see that figure's records; `null` means not enough has been measured yet. */
export async function loadSpeed(timeZone: string, can: { dispatch: boolean; tickets: boolean }): Promise<SpeedMetrics> {
  const supabase = await createClient();
  const since = new Date(Date.now() - SPEED_DAYS * 86_400_000).toISOString();
  const [assignments, reviews] = await Promise.all([
    can.dispatch
      ? all<{ starts_at: string; created_at: string }>((f, t) => supabase.from("dispatch_assignments").select("starts_at, created_at").gte("created_at", since).order("created_at").range(f, t))
      : null,
    can.tickets
      ? all<{ status: string; delivered_at: string | null; reviewed_at: string; reviewed_by: string | null }>((f, t) =>
          supabase.from("delivery_tickets").select("status, delivered_at, reviewed_at, reviewed_by").gte("reviewed_at", since).order("reviewed_at").range(f, t),
        )
      : null,
  ]);
  return {
    planning: assignments ? planningSpeed(assignments.map((a) => ({ loadDate: localDate(a.starts_at, timeZone), createdAt: a.created_at })), timeZone) : undefined,
    billingReady: reviews
      ? billingReadySpeed(reviews.filter((r) => r.status === "accepted" && r.delivered_at).map((r) => ({ deliveredAt: r.delivered_at!, reviewedAt: r.reviewed_at })))
      : undefined,
    pace: reviews ? reviewPace(reviews.filter((r) => r.reviewed_by).map((r) => ({ reviewer: r.reviewed_by!, reviewedAt: r.reviewed_at }))) : undefined,
  };
}

function localDate(at: string, timeZone: string) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(at));
}
