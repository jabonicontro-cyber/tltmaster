// Shift text, the day timeline and the staffing forecast (SCH-1): pure helpers over the schedule rows the database
// already resolved (public.schedule_range). Nothing here decides who works; it only reads the schedule back.

export interface ShiftDay {
  date: string;
  status: "shift" | "off" | "none";
  start: string | null; // "06:00"
  end: string | null;
  overnight: boolean;
  breakMinutes: number;
}

/** "06:00" → "6a", "16:30" → "4:30p". */
export function shortTime(t: string | null): string {
  if (!t) return "";
  const [h, m] = t.split(":").map(Number);
  return `${h % 12 || 12}${m ? `:${String(m).padStart(2, "0")}` : ""}${h < 12 ? "a" : "p"}`;
}

/** "06:00" → "6:00 AM". */
export function clockTime(t: string | null): string {
  if (!t) return "";
  const [h, m] = t.split(":").map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

/** The grid cell: "6a–4:30p", "Off" or "—" without a schedule. */
export function cellText(d: ShiftDay): string {
  if (d.status === "shift") return `${shortTime(d.start)}–${shortTime(d.end)}`;
  if (d.status === "off") return "Off";
  return "—";
}

/** One line for My Day: "6:00 AM – 4:30 PM · 30 min break", "Day off", or null without a schedule. */
export function shiftLine(d: ShiftDay | undefined): string | null {
  if (!d || d.status === "none") return null;
  if (d.status === "off") return "Day off";
  const end = `${clockTime(d.end)}${d.overnight ? " (next day)" : ""}`;
  return `${clockTime(d.start)} – ${end}${d.breakMinutes ? ` · ${d.breakMinutes} min break` : ""}`;
}

const minutes = (t: string) => {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
};

/**
 * Where a shift sits on a 24-hour day, in minutes from midnight. An overnight shift runs to the end of the day (and
 * says it continues); a shift is never drawn wider than the day.
 */
export function timelineBar(d: ShiftDay): { from: number; to: number; continues: boolean } | null {
  if (d.status !== "shift" || !d.start || !d.end) return null;
  const from = minutes(d.start);
  const end = minutes(d.end);
  return d.overnight || end <= from ? { from, to: 24 * 60, continues: true } : { from, to: end, continues: false };
}

export interface StaffingDay {
  date: string;
  /** Drivers (people with a driver record) on shift that day. */
  drivers: number;
  /** Drivers whose day is not set: neither a shift nor a day off. */
  unknown: number;
  /** Planned loads that day (null when the loads could not be read). */
  loads: number | null;
  /** Planned loads per driver on shift; null without drivers or loads. */
  perDriver: number | null;
}

/**
 * Drivers scheduled per day against planned loads. Only counts; how many loads a driver can haul in a day is each
 * company's own judgment, so no "short" verdict is invented here beyond loads with nobody scheduled at all.
 */
export function staffingForecast(people: Array<{ driverId: string | null; days: ShiftDay[] }>, dates: string[], loadsByDay: Record<string, number> | null): StaffingDay[] {
  const drivers = people.filter((p) => p.driverId);
  return dates.map((date) => {
    const days = drivers.map((p) => p.days.find((d) => d.date === date));
    const on = days.filter((d) => d?.status === "shift").length;
    const loads = loadsByDay ? (loadsByDay[date] ?? 0) : null;
    return { date, drivers: on, unknown: days.filter((d) => !d || d.status === "none").length, loads, perDriver: loads && on ? Math.round((loads / on) * 10) / 10 : null };
  });
}
