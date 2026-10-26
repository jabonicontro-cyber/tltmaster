import { addDays, todayIn } from "@/lib/dates";

/**
 * Speed metrics measured from real use (B86, owner 2026-10-25): how long planning tomorrow takes, how long a delivery
 * waits to be billing-ready, and how fast tickets are reviewed. Every figure comes from timestamps the product records
 * when people act; nothing is estimated. Too few measurements return null, shown as "not enough measured yet".
 */

/** Measurements needed before a figure is shown. */
export const MIN_DAYS = 3;
export const MIN_TICKETS = 5;
/** Reviews by one person this close together are one sitting. */
export const SESSION_GAP_MINUTES = 10;
/** Review time a sitting must add up to before a pace is shown. */
export const MIN_REVIEW_MINUTES = 5;
/** Actions recorded closer than this were not paced by a person (a batch, an import or a script); never timed. */
const SAME_ACTION_MS = 1000;

const median = (values: number[]) => {
  if (!values.length) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Minutes since midnight of a moment, in the business time zone. */
export function minutesOfDay(at: string, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(at));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return get("hour") * 60 + get("minute");
}

export interface PlanningSpeed {
  /** Median minutes from the first to the last truck assigned the day before. */
  medianMinutes: number;
  /** Median time of day the last truck was assigned, minutes since midnight. */
  medianDoneAt: number;
  days: number;
}

/**
 * Time to plan tomorrow: for each delivery day, the assignments made the day before it (in business time), from the
 * first to the last. Days with one assignment, or whose assignments were all recorded within a second (not paced by a
 * person), are not counted.
 */
export function planningSpeed(rows: Array<{ loadDate: string; createdAt: string }>, timeZone: string): PlanningSpeed | null {
  const byDay = new Map<string, number[]>();
  for (const r of rows) {
    if (todayIn(timeZone, new Date(r.createdAt)) !== addDays(r.loadDate, -1)) continue;
    byDay.set(r.loadDate, [...(byDay.get(r.loadDate) ?? []), Date.parse(r.createdAt)]);
  }
  const spans: number[] = [];
  const doneAt: number[] = [];
  for (const times of byDay.values()) {
    if (times.length < 2) continue;
    const first = Math.min(...times);
    const last = Math.max(...times);
    if (last - first < SAME_ACTION_MS) continue;
    spans.push((last - first) / 60000);
    doneAt.push(minutesOfDay(new Date(last).toISOString(), timeZone));
  }
  if (spans.length < MIN_DAYS) return null;
  return { medianMinutes: Math.round(median(spans)), medianDoneAt: Math.round(median(doneAt)), days: spans.length };
}

export interface BillingReadySpeed {
  /** Median hours from delivery to the ticket being accepted (billing-ready). */
  medianHours: number;
  /** Share accepted within a day of delivery, 0 to 1. */
  withinDay: number;
  tickets: number;
}

/** Delivery to billing-ready: delivered_at to the accepting review, for accepted tickets. */
export function billingReadySpeed(rows: Array<{ deliveredAt: string; reviewedAt: string }>): BillingReadySpeed | null {
  const hours = rows.map((r) => (Date.parse(r.reviewedAt) - Date.parse(r.deliveredAt)) / 3_600_000).filter((h) => Number.isFinite(h) && h >= 0);
  if (hours.length < MIN_TICKETS) return null;
  return { medianHours: Math.round(median(hours) * 10) / 10, withinDay: hours.filter((h) => h <= 24).length / hours.length, tickets: hours.length };
}

export interface ReviewPace {
  /** Tickets reviewed per minute of review time. */
  perMinute: number;
  /** Reviews that were timed (the first of each sitting and same-moment batches are not). */
  timed: number;
  minutes: number;
  sittings: number;
}

/**
 * Tickets per minute: each person's reviews are split into sittings (gaps of at most ten minutes); within a sitting,
 * the time since the previous review is the time that ticket took. A sitting's first review has no measured start, and
 * reviews recorded within a second of the previous one (a batch) add no time, so neither is timed.
 */
export function reviewPace(rows: Array<{ reviewer: string; reviewedAt: string }>): ReviewPace | null {
  const byPerson = new Map<string, number[]>();
  for (const r of rows) byPerson.set(r.reviewer, [...(byPerson.get(r.reviewer) ?? []), Date.parse(r.reviewedAt)]);
  let timed = 0;
  let ms = 0;
  let sittings = 0;
  for (const times of byPerson.values()) {
    times.sort((a, b) => a - b);
    let open = false;
    for (let i = 1; i < times.length; i++) {
      const gap = times[i] - times[i - 1];
      if (gap > SESSION_GAP_MINUTES * 60_000) { open = false; continue; }
      if (gap < SAME_ACTION_MS) continue;
      if (!open) { sittings++; open = true; }
      timed++;
      ms += gap;
    }
  }
  const minutes = ms / 60_000;
  if (timed < MIN_TICKETS || minutes < MIN_REVIEW_MINUTES) return null;
  return { perMinute: Math.round((timed / minutes) * 10) / 10, timed, minutes: Math.round(minutes), sittings };
}
