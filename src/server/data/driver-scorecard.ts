import "server-only";
import type { ScoreRow } from "@/lib/drivers/scorecard";
import { createClient } from "@/server/supabase/server";

/** Scorecard rows the database lets this person see (their own as a driver; everyone with dispatch or employee access). null when the update is not installed. */
export async function loadScorecard(from: string, to: string, mine = false): Promise<ScoreRow[] | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("driver_scorecard", { p_from: from, p_to: to, p_mine: mine });
  if (error) {
    if (["PGRST202", "42883"].includes(error.code ?? "")) return null;
    throw new Error(`Could not load the driver scorecard: ${error.message}`);
  }
  return ((data ?? []) as ScoreRow[]).map((r) => ({ ...r, loads: Number(r.loads), on_time: Number(r.on_time), own_tickets: Number(r.own_tickets), same_day: Number(r.same_day), reports: Number(r.reports) }));
}
