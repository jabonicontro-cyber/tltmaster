/**
 * Wait times at pickups and job sites (B111): pure helpers. Track only (owner 2026-11-01): nothing here bills or
 * charges. A wait is "left − arrived"; it counts as long only when the company set a free time and the wait exceeds it.
 */

export type Stop = "pickup" | "site";

export interface StopTime {
  loadId: string;
  orderId: string;
  orderNumber: string;
  stop: Stop;
  /** Where: the job site (order's site) or the pickup location's name; null when not recorded. */
  placeKey: string | null;
  placeLabel: string | null;
  customerName: string | null;
  arrivedAt: string | null;
  departedAt: string | null;
  source: "driver" | "office" | "demo";
}

export const STOP_LABEL: Record<Stop, string> = { pickup: "Pickup", site: "Job site" };

/** Whole minutes waited, or null while the truck has not left (or never arrived). */
export function waitMinutes(s: Pick<StopTime, "arrivedAt" | "departedAt">): number | null {
  if (!s.arrivedAt || !s.departedAt) return null;
  return Math.max(0, Math.round((new Date(s.departedAt).getTime() - new Date(s.arrivedAt).getTime()) / 60_000));
}

export function isLong(minutes: number | null, freeMinutes: number | null): boolean {
  return minutes !== null && freeMinutes !== null && minutes > freeMinutes;
}

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const v = [...values].sort((a, b) => a - b);
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : Math.round((v[m - 1] + v[m]) / 2);
}

export interface PlaceSummary {
  key: string;
  label: string;
  stop: Stop;
  customerName: string | null;
  visits: number;
  medianMinutes: number | null;
  longest: number | null;
  /** Visits over the free time; null when no free time is set. */
  long: number | null;
  /** Minutes beyond the free time, summed; null when no free time is set. */
  minutesOver: number | null;
}

/** Finished waits grouped by place, slowest (median) first. Stops without a place are grouped as "Not recorded". */
export function summarizeByPlace(rows: StopTime[], freeMinutes: number | null): PlaceSummary[] {
  const groups = new Map<string, { label: string; stop: Stop; customer: string | null; waits: number[] }>();
  for (const r of rows) {
    const w = waitMinutes(r);
    if (w === null) continue;
    const key = `${r.stop}:${r.placeKey ?? "none"}`;
    const g = groups.get(key) ?? { label: r.placeLabel ?? (r.stop === "pickup" ? "Pickup not recorded" : "Site not recorded"), stop: r.stop, customer: r.customerName, waits: [] };
    g.waits.push(w);
    groups.set(key, g);
  }
  return [...groups.entries()].map(([key, g]) => ({
    key, label: g.label, stop: g.stop, customerName: g.stop === "site" ? g.customer : null, visits: g.waits.length,
    medianMinutes: median(g.waits), longest: Math.max(...g.waits),
    long: freeMinutes === null ? null : g.waits.filter((w) => w > freeMinutes).length,
    minutesOver: freeMinutes === null ? null : g.waits.reduce((n, w) => n + Math.max(0, w - freeMinutes), 0),
  })).sort((a, b) => (b.medianMinutes ?? 0) - (a.medianMinutes ?? 0) || b.visits - a.visits);
}

/** "1 h 5 min", "45 min". */
export function minutesLabel(m: number | null): string {
  if (m === null) return "–";
  return m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}` : `${m} min`;
}
