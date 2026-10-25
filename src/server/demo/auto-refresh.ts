import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { todayIn } from "@/lib/dates";
import { refreshNorthfield } from "./northfield-refresh";
import { PRAIRIE_LANTERN } from "./prairie-lantern";
import { refreshPrairieLantern } from "./prairie-lantern-refresh";
import { ensureFeatureSamples } from "./samples";

// Demos refresh themselves (owner 2026-10-25; migration 20261120002800). When a demo owner opens a demo company, the
// same additive refresh as Admin → Demo → "Refresh demo data" runs after the page is sent, once per deployed version and
// once per day. The database decides whether to run (demo_auto_refresh_claim: demo, owner, not yet at this version
// and day, nothing in progress); real companies are never refreshed. A failure is recorded and retried an hour later.

/** The deployed build; each deployment is a new version. */
export const DEMO_SAMPLES_VERSION = process.env.VERCEL_GIT_COMMIT_SHA || "local";

export async function autoRefreshDemo(db: SupabaseClient): Promise<void> {
  const { data: access } = await db.rpc("my_access");
  const companyId = (access as { company_id?: string } | null)?.company_id;
  if (!companyId) return;
  const [{ data: company }, { data: settings }] = await Promise.all([
    db.from("companies").select("name, demo_kind, is_demo").eq("id", companyId).maybeSingle(),
    db.from("company_settings").select("timezone").maybeSingle(),
  ]);
  const c = company as { name: string; demo_kind: string | null; is_demo: boolean } | null;
  if (!c?.is_demo) return;
  const timeZone = (settings as { timezone?: string | null } | null)?.timezone || PRAIRIE_LANTERN.timeZone;
  const day = todayIn(timeZone);
  const claim = await db.rpc("demo_auto_refresh_claim", { p_version: DEMO_SAMPLES_VERSION, p_day: day });
  if (claim.error || claim.data !== true) return; // not installed, not an owner, already current, or running elsewhere
  let ok = true;
  let summary: string;
  try {
    if (c.demo_kind === "presenter") {
      const r = await refreshNorthfield(db);
      summary = `${r.loads} loads and ${r.added} missing records added`;
    } else if (c.name === PRAIRIE_LANTERN.name) {
      const r = await refreshPrairieLantern(db, timeZone);
      summary = `${r.loads} loads and ${r.added} missing records added`;
    } else {
      const r = await ensureFeatureSamples(db, day);
      summary = `${r.added} missing records added`;
    }
  } catch (e) {
    ok = false;
    summary = e instanceof Error ? e.message : "The demo could not be refreshed.";
  }
  await db.rpc("demo_auto_refresh_finish", { p_version: DEMO_SAMPLES_VERSION, p_day: day, p_ok: ok, p_summary: summary });
}
