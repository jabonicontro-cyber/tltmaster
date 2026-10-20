// Dates. Calendar dates (quote date, expiration) are stored as DATE and
// handled as "YYYY-MM-DD" strings; timestamps are displayed in the business
// timezone (company_settings.timezone, chosen by each company; DEFAULT_TIMEZONE
// is only a fallback for display when no setting is available).

export const DEFAULT_TIMEZONE = "America/Chicago";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar date "YYYY-MM-DD" with a year from 1900 to 2100 (birth or hire dates may be old). */
export function isIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const year = Number(value.slice(0, 4));
  if (year < 1900 || year > 2100) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/**
 * A date for operational work — quotes, orders, schedules, loads, tickets —
 * with a four-digit year from 2000 to 2099. Catches "26" typed as a year
 * (stored as 0026) and similar slips.
 */
export function isOperationalDate(value: string): boolean {
  return isIsoDate(value) && value >= "2000-01-01" && value <= "2099-12-31";
}
export const OPERATIONAL_DATE_MESSAGE = "Enter a full date with a 4-digit year (2000–2099).";

/** "0026-10-15" (a two-digit year typed into a date field) → "2026-10-15"; anything else unchanged. */
export function normalizeTypedDate(value: string): string {
  const m = /^00(\d{2})-(\d{2})-(\d{2})$/.exec(value);
  return m ? `20${m[1]}-${m[2]}-${m[3]}` : value;
}

/** "2026-10-19" → "10/19/2026", the format people type; "" for anything that is not a real date. */
export function isoToTyped(iso: string | null | undefined): string {
  if (!iso || !isIsoDate(iso)) return "";
  return `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)}`;
}

export type TypedDate = { ok: true; iso: string } | { ok: false; empty: boolean; error: string };

/**
 * A date typed by a person: "10/19/2026", "10-19-2026", "10.19.2026", "1/5/2026", "10/19/26" (2000s) or a pasted
 * "2026-10-19". Month lengths and leap years are checked; an impossible date (02/30/2026) is an error, never moved
 * to another day. `min`/`max` are ISO dates.
 */
export function parseTypedDate(text: string, min = "2000-01-01", max = "2099-12-31"): TypedDate {
  const t = text.trim();
  if (!t) return { ok: false, empty: true, error: "Enter a date as MM/DD/YYYY." };
  let y: number, m: number, d: number;
  const us = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(t);
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  if (us) {
    [m, d, y] = [Number(us[1]), Number(us[2]), Number(us[3])];
    if (us[3].length === 2) y += 2000;
  } else if (iso) {
    [y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  } else {
    return { ok: false, empty: false, error: "Enter the date as MM/DD/YYYY, for example 10/19/2026." };
  }
  if (m < 1 || m > 12) return { ok: false, empty: false, error: `There is no month ${m}. Use MM/DD/YYYY.` };
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (d < 1 || d > daysInMonth) return { ok: false, empty: false, error: `${String(m).padStart(2, "0")}/${y} has ${daysInMonth} days.` };
  const value = `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  if (value < min || value > max) return { ok: false, empty: false, error: `Choose a date between ${isoToTyped(min)} and ${isoToTyped(max)}.` };
  return { ok: true, iso: value };
}

/** "2026-10-01" → "Oct 1, 2026" (no timezone shift). */
export function formatDate(value: string | null | undefined): string {
  if (!value) return "";
  const d = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" }).format(d);
}

/** Long form for documents: "October 1, 2026". */
export function formatDateLong(value: string | null | undefined): string {
  if (!value) return "";
  const d = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "long", day: "numeric", year: "numeric" }).format(d);
}

export function formatDateTime(value: string | null | undefined, timeZone = DEFAULT_TIMEZONE): string {
  if (!value) return "";
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(value));
}

/** Today's calendar date in the given timezone, as YYYY-MM-DD. */
export function todayIn(timeZone = DEFAULT_TIMEZONE, now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function zoneOffsetMs(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) - utcMs;
}

/**
 * A wall-clock date and time in the business time zone ("2026-10-12", "14:30")
 * as a UTC ISO timestamp, or null when the input is not a valid date/time.
 * Handles daylight-saving offsets (two passes, as the offset depends on the instant).
 */
export function zonedTimeToUtc(isoDate: string, hhmm: string, timeZone: string): string | null {
  if (!isIsoDate(isoDate) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(hhmm)) return null;
  const [y, m, d] = isoDate.split("-").map(Number);
  const [h, mi] = hhmm.split(":").map(Number);
  const wall = Date.UTC(y, m - 1, d, h, mi);
  let utc = wall - zoneOffsetMs(wall, timeZone);
  utc = wall - zoneOffsetMs(utc, timeZone);
  return new Date(utc).toISOString();
}
