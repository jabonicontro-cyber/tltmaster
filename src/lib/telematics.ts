/**
 * GPS and hours of service (B101): shared, pure helpers. Provider-neutral: a company records positions and hours by
 * hand or receives them from a provider feed (migration 20261120004900). Nothing here estimates a position or hours;
 * it only labels what was recorded, how old it is, and where it came from.
 */

export type TelematicsSource = "none" | "manual" | "feed";
export type RecordSource = "manual" | "feed" | "demo";
export type DutyStatus = "off_duty" | "sleeper" | "driving" | "on_duty";

export const SOURCE_OPTIONS: Array<{ value: TelematicsSource; label: string; description: string }> = [
  { value: "none", label: "Off", description: "No positions or hours in Taviron. Dispatchers confirm each driver's hours themselves." },
  { value: "manual", label: "Entered by hand", description: "Dispatch records a truck's last known location and a driver's hours from a call or the ELD screen. Shown with who entered it; never treated as verified." },
  { value: "feed", label: "Provider feed", description: "Your GPS or ELD provider (or a connector) sends positions and hours to Taviron with your feed key. Current feed hours can verify a driver for dispatch." },
];

export const DUTY_LABEL: Record<DutyStatus, string> = { off_duty: "Off duty", sleeper: "Sleeper berth", driving: "Driving", on_duty: "On duty, not driving" };
export const DUTY_TONE: Record<DutyStatus, "green" | "blue" | "gray" | "amber"> = { off_duty: "gray", sleeper: "gray", driving: "blue", on_duty: "green" };
export const RECORD_SOURCE_LABEL: Record<RecordSource, string> = { manual: "Entered by hand", feed: "Provider feed", demo: "Sample (demo)" };

export interface StatusInfo {
  source: TelematicsSource;
  staleMinutes: number;
  feedKeyHint: string;
  feedKeyAt: string | null;
  lastFeedAt: string | null;
}

export const DEFAULT_STATUS: StatusInfo = { source: "none", staleMinutes: 30, feedKeyHint: "", feedKeyAt: null, lastFeedAt: null };

export function parseStatus(raw: unknown): StatusInfo {
  const r = (raw ?? {}) as Record<string, unknown>;
  const source = r.source === "manual" || r.source === "feed" ? r.source : "none";
  const stale = Number(r.stale_minutes);
  return {
    source,
    staleMinutes: Number.isFinite(stale) && stale >= 5 ? stale : 30,
    feedKeyHint: typeof r.feed_key_hint === "string" ? r.feed_key_hint : "",
    feedKeyAt: typeof r.feed_key_at === "string" ? r.feed_key_at : null,
    lastFeedAt: typeof r.last_feed_at === "string" ? r.last_feed_at : null,
  };
}

/** Whole minutes since a timestamp (never negative). */
export function ageMinutes(at: string, now: Date = new Date()): number {
  return Math.max(0, Math.floor((now.getTime() - new Date(at).getTime()) / 60_000));
}

/** "Just now", "12 min ago", "3 h 5 min ago", "2 days ago". */
export function ageLabel(at: string, now: Date = new Date()): string {
  const m = ageMinutes(at, now);
  if (m < 1) return "Just now";
  if (m < 60) return `${m} min ago`;
  if (m < 24 * 60) return `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""} ago`;
  const d = Math.floor(m / (24 * 60));
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

export function isStale(at: string, staleMinutes: number, now: Date = new Date()): boolean {
  return ageMinutes(at, now) > staleMinutes;
}

/** Minutes as "5 h 12 min"; null when the clock was not reported. */
export function clockLabel(minutes: number | null): string | null {
  if (minutes === null || minutes === undefined) return null;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  return m ? `${h} h ${m} min` : `${h} h`;
}

export interface HoursRecord {
  driverId: string;
  asOf: string;
  dutyStatus: DutyStatus;
  driveLeft: number | null;
  shiftLeft: number | null;
  cycleLeft: number | null;
  source: RecordSource;
}

/**
 * Whether a driver's hours count as verified for a load on `loadDate`: only data from a provider feed, while the company
 * uses the feed, no older than its limit, for a load today, with drive and shift time both reported and above zero.
 * Hand-entered and sample hours never verify; a future day can't be verified from today's clocks. Anything else falls
 * back to the dispatcher's confirmation (src/lib/hos).
 */
export function hoursVerified(rec: HoursRecord | undefined, status: Pick<StatusInfo, "source" | "staleMinutes">, loadDate: string, today: string, now: Date = new Date()): boolean {
  if (!rec || status.source !== "feed" || rec.source !== "feed") return false;
  if (loadDate !== today || isStale(rec.asOf, status.staleMinutes, now)) return false;
  return rec.driveLeft !== null && rec.driveLeft > 0 && rec.shiftLeft !== null && rec.shiftLeft > 0;
}

/** A short line for dispatch: "Driving · 5 h 12 min drive left · 12 min ago (hand entry)". */
export function hoursSummary(rec: HoursRecord, now: Date = new Date()): string {
  const parts = [DUTY_LABEL[rec.dutyStatus]];
  const drive = clockLabel(rec.driveLeft);
  if (drive) parts.push(`${drive} drive left`);
  parts.push(`${ageLabel(rec.asOf, now).toLowerCase()} (${RECORD_SOURCE_LABEL[rec.source].toLowerCase()})`);
  return parts.join(" · ");
}

/** The feed key shown once: "tlk_" + 40 hex characters. Only its SHA-256 is stored. */
export const FEED_KEY_PATTERN = /^tlk_[0-9a-f]{40}$/;

/** "5:30" → 330, "5" → 300, "" → null; "bad" when unreadable or over `maxHours`. */
export function parseClock(raw: string, maxHours: number): number | null | "bad" {
  const v = raw.trim();
  if (!v) return null;
  const m = /^(\d{1,3})(?::([0-5]\d))?$/.exec(v);
  if (!m) return "bad";
  const minutes = Number(m[1]) * 60 + Number(m[2] ?? 0);
  return minutes > maxHours * 60 ? "bad" : minutes;
}
