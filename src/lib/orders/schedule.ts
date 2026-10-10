// Display helpers for order scheduling fields (dates as YYYY-MM-DD, times as HH:MM[:SS]).
import { formatDate } from "@/lib/dates";

/** "14:30:00" → "2:30 PM". */
export function formatTime(value: string | null | undefined): string {
  if (!value) return "";
  const [h, m] = value.split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return "";
  const suffix = h < 12 ? "AM" : "PM";
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${String(m).padStart(2, "0")} ${suffix}`;
}

/** "Oct 14, 2026", "Oct 14, 2026 – Oct 16, 2026" or "" when not scheduled. */
export function formatScheduleDates(start: string | null, end: string | null): string {
  if (!start) return "";
  return end && end !== start ? `${formatDate(start)} – ${formatDate(end)}` : formatDate(start);
}

export function formatWindow(start: string | null, end: string | null): string {
  return start && end ? `${formatTime(start)} – ${formatTime(end)}` : "";
}

/**
 * The customer asked for delivery by a date, and the order is not scheduled
 * by then (or not scheduled at all) while still open.
 */
export function isPastRequested(o: { requested_date: string | null; scheduled_start: string | null; status: string }, today: string): boolean {
  if (!o.requested_date || ["completed", "canceled", "in_progress", "partially_completed"].includes(o.status)) return false;
  if (o.scheduled_start) return o.scheduled_start > o.requested_date;
  return o.requested_date < today;
}
