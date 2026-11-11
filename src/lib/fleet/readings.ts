/**
 * A truck's odometer and engine-hour readings on its page (owner 2026-11-09, MD1).
 *
 * The current reading is the highest reading not marked wrong, the latest one among equal values: the same rule the
 * database uses (private.feed_truck_reading, private.pm_due, record_truck_reading; 20261120015100 / 20261120015600).
 * The page loads only the newest readings by date, so an old wrong reading that is higher than everything since is
 * read separately on the server (`highest`) and always listed first, where it can be marked wrong.
 */

export interface TruckReading {
  id: string;
  odometer_miles: number | null;
  engine_hours: number | null;
  read_at: string;
  set_aside_at?: string | null;
}

export interface CurrentReading<R extends TruckReading = TruckReading> {
  odometer_miles: number | null;
  engine_hours: number | null;
  /** The reading rows that set the current values (one, or two when miles and hours come from different readings). */
  setBy: R[];
}

type Kind = "odometer_miles" | "engine_hours";

/** Highest value not set aside; the latest read among equal values (the database's order). */
function highestOf<R extends TruckReading>(rows: R[], k: Kind): R | null {
  let best: R | null = null;
  for (const r of rows) {
    if (r.set_aside_at || r[k] === null) continue;
    if (!best || r[k]! > best[k]! || (r[k] === best[k] && r.read_at > best.read_at)) best = r;
  }
  return best;
}

/**
 * The truck's current reading. `highest` holds the rows the server read with the database's rule (the highest
 * odometer and the highest engine hours not set aside, over every reading); without it (before the set-aside update)
 * the current reading is worked out from the loaded rows.
 */
export function currentReading<R extends TruckReading>(rows: R[], highest?: { odometer: R | null; hours: R | null } | null): CurrentReading<R> {
  const pool = highest ? [...(highest.odometer ? [highest.odometer] : []), ...(highest.hours ? [highest.hours] : []), ...rows] : rows;
  const miles = highestOf(pool, "odometer_miles");
  const hours = highestOf(pool, "engine_hours");
  const setBy: R[] = [];
  for (const r of [miles, hours]) if (r && !setBy.some((s) => s.id === r.id)) setBy.push(r);
  return { odometer_miles: miles?.odometer_miles ?? null, engine_hours: hours?.engine_hours ?? null, setBy };
}

/** The readings to list: the ones that set the current reading first, then the newest others, `limit` in all. */
export function readingsToList<R extends TruckReading>(rows: R[], current: CurrentReading<R>, limit = 8): Array<R & { isCurrent: boolean }> {
  const ids = new Set(current.setBy.map((r) => r.id));
  const first = current.setBy.map((r) => ({ ...r, isCurrent: true }));
  const rest = rows.filter((r) => !ids.has(r.id)).map((r) => ({ ...r, isCurrent: false }));
  return [...first, ...rest].slice(0, Math.max(limit, first.length));
}

const fmt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 1 });

const FROM: Record<string, string> = {
  inspection: "an inspection", trip_sheet: "a trip sheet", fuel: "a fuel entry", work_order: "a work order",
};

/**
 * One "Readings not used" line in plain words with formatted numbers ("236,466 mi", not "236466.0"), from the audit
 * details ('truck.reading_ignored', 20261120012200); the stored summary is the fallback.
 */
export function ignoredReadingText(e: { summary: string; details?: { value?: number | string; current?: number | string | null; kind?: string; why?: string; source?: string } | null }): string {
  const d = e.details ?? {};
  const value = d.value === undefined || d.value === null ? NaN : Number(d.value);
  const current = d.current === undefined || d.current === null ? NaN : Number(d.current);
  if (!Number.isFinite(value) || !Number.isFinite(current) || (d.kind !== "odometer" && d.kind !== "engine_hours") || (d.why !== "lower" && d.why !== "implausible")) {
    // Older or unexpected rows: keep the summary but format bare decimals such as 236466.0.
    return e.summary.replace(/\b(\d{4,}(?:\.\d+)?)(?=\s*(?:mi|h)\b)/g, (_, n: string) => fmt(Number(n)));
  }
  const from = d.source && FROM[d.source] ? ` from ${FROM[d.source]}` : "";
  // The current reading at the time; it may have changed since (a reading marked wrong, a newer one).
  const how = d.why === "lower" ? "lower than" : "too far above";
  return d.kind === "odometer"
    ? `Odometer ${fmt(value)} mi${from} was not used: ${how} the current reading at the time, ${fmt(current)} mi.`
    : `Engine hours ${fmt(value)}${from} were not used: ${how} the current reading at the time, ${fmt(current)} h.`;
}
