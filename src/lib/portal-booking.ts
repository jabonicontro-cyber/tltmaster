// Customer self-booking (B115): labels and the staff capacity view, shared by the staff page and the portal.

export type BookingStatus = "pending" | "approved" | "declined" | "canceled";
export type TimeWindow = "any" | "morning" | "afternoon";

export const BOOKING_STATUS: Record<BookingStatus, { label: string; tone: "amber" | "green" | "red" | "gray" }> = {
  pending: { label: "Waiting for dispatch", tone: "amber" },
  approved: { label: "Approved", tone: "green" },
  declined: { label: "Declined", tone: "red" },
  canceled: { label: "Withdrawn", tone: "gray" },
};

export const TIME_WINDOW: Record<TimeWindow, string> = { any: "Any time", morning: "Morning", afternoon: "Afternoon" };

export interface CapacityDay {
  day: string;
  /** Loads opened for customers; null when the day was never opened. */
  open: number | null;
  /** Loads taken by pending and approved requests. */
  taken: number;
}

/** Staff view: every day from today for `days` days, with what was opened and what customers took. */
export function capacityDays(today: string, days: number, capacity: Array<{ day: string; loads: number }>, requests: Array<{ day: string; loads: number; status: string }>): CapacityDay[] {
  const open = new Map(capacity.map((c) => [c.day, c.loads]));
  const taken = new Map<string, number>();
  for (const r of requests) if (r.status === "pending" || r.status === "approved") taken.set(r.day, (taken.get(r.day) ?? 0) + r.loads);
  const start = Date.parse(`${today}T12:00:00Z`);
  return Array.from({ length: days }, (_, i) => {
    const day = new Date(start + i * 86_400_000).toISOString().slice(0, 10);
    return { day, open: open.has(day) ? open.get(day)! : null, taken: taken.get(day) ?? 0 };
  });
}
