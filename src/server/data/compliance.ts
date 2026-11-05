import "server-only";
import { addDays } from "@/lib/dates";
import type { CalendarInput } from "@/lib/fleet/compliance-calendar";
import { createClient } from "@/server/supabase/server";
import { listPmStatus } from "./maintenance";
import { businessToday } from "./settings";

const MISSING = new Set(["42P01", "PGRST205", "42883", "PGRST202", "42703"]);

/**
 * What the compliance calendar needs (master plan CC1), read with the person's own access (RLS, current company):
 * drivers and their credentials, truck and trailer documents, date-based preventive service when the person sees
 * maintenance, and whether the company keeps trip sheets (then the IFTA quarter is listed). A section that can't be read
 * is left out rather than shown as all clear: `missing` names it.
 */
export async function loadCalendarInput(opts: { maintenance: boolean }): Promise<{ input: CalendarInput; missing: string[] }> {
  const supabase = await createClient();
  const { today } = await businessToday();
  const missing: string[] = [];
  const rows = async <T,>(label: string, p: PromiseLike<{ data: unknown; error: { code?: string; message: string } | null }>): Promise<T[]> => {
    const { data, error } = await p;
    if (error) {
      if (!MISSING.has(error.code ?? "")) missing.push(label);
      return [];
    }
    return (data ?? []) as T[];
  };
  const [drivers, quals, docs, trucks, trailers, trips, service] = await Promise.all([
    rows<{ id: string; name: string }>("drivers", supabase.from("drivers").select("id, name").eq("active", true)),
    rows<CalendarInput["quals"][number]>("driver credentials", supabase.from("driver_qualifications").select("id, driver_id, kind, expires_on, description").not("expires_on", "is", null)),
    rows<CalendarInput["docs"][number]>("truck and trailer documents", supabase.from("vehicle_documents").select("id, truck_id, trailer_id, kind, title, expires_on, archived_at").is("archived_at", null).not("expires_on", "is", null)),
    rows<{ id: string; unit_number: string; active: boolean }>("trucks", supabase.from("trucks").select("id, unit_number, active")),
    rows<{ id: string; unit_number: string; active: boolean }>("trailers", supabase.from("trailers").select("id, unit_number, active")),
    rows<{ id: string }>("trip sheets", supabase.from("trip_sheets").select("id").gte("sheet_date", addDays(today, -365)).limit(1)),
    opts.maintenance ? listPmStatus().catch(() => { missing.push("preventive service"); return null; }) : Promise.resolve(null),
  ]);
  return {
    input: { today, drivers, quals, docs, trucks, trailers, ifta: trips.length > 0, service: service ? service.map((s) => ({ schedule_id: s.schedule_id, truck_id: s.truck_id, unit_number: s.unit_number, name: s.name, next_due_on: s.next_due_on })) : null },
    missing,
  };
}
