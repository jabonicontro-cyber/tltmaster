import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { todayIn } from "@/lib/dates";
import { refreshNorthfield } from "./northfield-refresh";
import { PRAIRIE_LANTERN } from "./prairie-lantern";
import { refreshPrairieLantern } from "./prairie-lantern-refresh";
import { ensureFeatureSamples } from "./samples";

// Demos refresh themselves (owner 2026-10-25; migration 20261120002800). When a demo owner opens a demo company, the
// same additive refresh as Admin → Demo → "Refresh demo data" runs after the page is sent, once per deployed version,
// day and six-hour window (refreshKey). The database decides whether to run (demo_auto_refresh_claim: demo, owner, not yet at this version
// and day, nothing in progress); real companies are never refreshed. A failure is recorded and retried an hour later.

/** The deployed build; each deployment is a new version. */
export const DEMO_SAMPLES_VERSION = process.env.VERCEL_GIT_COMMIT_SHA || "local";

/**
 * The claim key: the build plus a six-hour window. A database update applied after the deployment (the migration
 * workflow runs after CI, and destructive-looking ones wait for the owner) therefore reaches the demos within six
 * hours instead of the next day. The refresh only adds what is missing, so the extra runs change nothing otherwise.
 */
export function refreshKey(now = new Date()): string {
  return `${DEMO_SAMPLES_VERSION}@${Math.floor(now.getUTCHours() / 6)}`;
}

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
  // The lock is shared with the manual refresh (withDemoRefreshLock), so the two never add the same samples at once.
  const key = refreshKey();
  const claim = await db.rpc("demo_auto_refresh_claim", { p_version: key, p_day: day });
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
  await db.rpc("demo_auto_refresh_finish", { p_version: key, p_day: day, p_ok: ok, p_summary: summary });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Run a manual refresh of the current demo under the same lock as the automatic one (migration 20261120003200): when an
 * automatic refresh is already running (it starts when a demo owner opens the demo after a deployment), wait for it to
 * finish (up to 45 s: the admin page allows 60 s) instead of adding the same samples at the same time. Without the
 * migration the refresh runs unlocked, as before.
 */
export async function withDemoRefreshLock<T>(db: SupabaseClient, run: () => Promise<T>): Promise<T> {
  const { data: settings } = await db.from("company_settings").select("timezone").maybeSingle();
  const day = todayIn((settings as { timezone?: string | null } | null)?.timezone || PRAIRIE_LANTERN.timeZone);
  let begin = await db.rpc("demo_refresh_begin");
  if (begin.error) return run(); // not installed yet
  for (let waited = 0; begin.data !== true && waited < 45_000; waited += 3_000) {
    await sleep(3_000);
    begin = await db.rpc("demo_refresh_begin");
  }
  if (begin.data !== true) throw new Error("Another refresh of this demo is still running. Try again in a few minutes.");
  let ok = false;
  try {
    const result = await run();
    ok = true;
    return result;
  } finally {
    await db.rpc("demo_refresh_end", { p_version: refreshKey(), p_day: day, p_ok: ok });
  }
}
