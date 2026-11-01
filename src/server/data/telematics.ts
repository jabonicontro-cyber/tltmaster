import "server-only";
import { feedHosProvider, NO_HOS_PROVIDER, type HosProvider } from "@/lib/hos";
import { DEFAULT_STATUS, parseStatus, type DutyStatus, type HoursRecord, type RecordSource, type StatusInfo } from "@/lib/telematics";
import { businessToday } from "@/server/data/settings";
import { createClient } from "@/server/supabase/server";

// GPS and hours of service (B101, migration 20261120004900), read through the person's session (dispatch.view or
// fleet.view, RLS). Before the migration is installed the loaders say so instead of failing the page.

const MISSING = new Set(["42P01", "PGRST205", "42883", "PGRST202"]);

export interface Telematics extends StatusInfo { installed: boolean }

export async function telematicsStatus(): Promise<Telematics> {
  const { data, error } = await (await createClient()).rpc("telematics_status");
  if (error) return { ...DEFAULT_STATUS, installed: !MISSING.has(error.code ?? "") };
  return { ...parseStatus(data), installed: true };
}

export interface PositionRecord {
  truckId: string;
  recordedAt: string;
  latitude: number;
  longitude: number;
  speedMph: number | null;
  source: RecordSource;
  note: string;
  enteredBy: string | null;
}

type PosRow = { truck_id: string; recorded_at: string; latitude: number; longitude: number; speed_mph: string | null; source: RecordSource; note: string; entered_by: string | null };
type HoursRow = { driver_id: string; as_of: string; duty_status: DutyStatus; drive_minutes_left: number | null; shift_minutes_left: number | null; cycle_minutes_left: number | null; source: RecordSource };

const toHours = (r: HoursRow): HoursRecord => ({
  driverId: r.driver_id, asOf: r.as_of, dutyStatus: r.duty_status, driveLeft: r.drive_minutes_left, shiftLeft: r.shift_minutes_left,
  cycleLeft: r.cycle_minutes_left, source: r.source,
});

/** The latest position per truck and the latest hours per driver, from the last 7 days. */
export async function latestTelematics(): Promise<{ positions: Map<string, PositionRecord>; hours: Map<string, HoursRecord> }> {
  const supabase = await createClient();
  const since = new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
  const [pos, hrs] = await Promise.all([
    supabase.from("vehicle_positions").select("truck_id, recorded_at, latitude, longitude, speed_mph, source, note, entered_by").gte("recorded_at", since).order("recorded_at", { ascending: false }).limit(2000),
    supabase.from("driver_hours").select("driver_id, as_of, duty_status, drive_minutes_left, shift_minutes_left, cycle_minutes_left, source").gte("as_of", since).order("as_of", { ascending: false }).limit(2000),
  ]);
  const positions = new Map<string, PositionRecord>();
  for (const r of (pos.data ?? []) as PosRow[]) {
    if (positions.has(r.truck_id)) continue;
    positions.set(r.truck_id, {
      truckId: r.truck_id, recordedAt: r.recorded_at, latitude: Number(r.latitude), longitude: Number(r.longitude),
      speedMph: r.speed_mph === null ? null : Number(r.speed_mph), source: r.source, note: r.note, enteredBy: r.entered_by,
    });
  }
  const hours = new Map<string, HoursRecord>();
  for (const r of (hrs.data ?? []) as HoursRow[]) if (!hours.has(r.driver_id)) hours.set(r.driver_id, toHours(r));
  return { positions, hours };
}

/**
 * The hours-of-service provider for an approval: verifies drivers only when the company uses a provider feed and the
 * feed's hours are current (src/lib/telematics hoursVerified). Any error means "not verified" (the dispatcher confirms).
 */
export async function loadHosProvider(driverIds: string[]): Promise<HosProvider> {
  try {
    const status = await telematicsStatus();
    if (!status.installed || status.source !== "feed" || driverIds.length === 0) return NO_HOS_PROVIDER;
    const supabase = await createClient();
    const since = new Date(Date.now() - (status.staleMinutes + 5) * 60_000).toISOString();
    const { data, error } = await supabase.from("driver_hours")
      .select("driver_id, as_of, duty_status, drive_minutes_left, shift_minutes_left, cycle_minutes_left, source")
      .in("driver_id", driverIds).gte("as_of", since).order("as_of", { ascending: false }).limit(500);
    if (error) return NO_HOS_PROVIDER;
    const { today } = await businessToday();
    return feedHosProvider(((data ?? []) as HoursRow[]).map(toHours), status, today);
  } catch {
    return NO_HOS_PROVIDER;
  }
}
