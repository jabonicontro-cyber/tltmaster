import "server-only";
import type { CompletedJob } from "@/lib/maintenance-estimate";
import { createClient } from "@/server/supabase/server";

// Completed work orders with their recorded labor (B91), read with the person's own session (RLS: maintenance.view).
// Hours are the time logged by the crew (voided entries left out), or the labor hours recorded on the job when no time
// was logged. Jobs with neither are left out: no labor recorded means nothing to learn from.

const MISSING = new Set(["42P01", "PGRST205", "42703", "PGRST204"]);

export async function completedJobs(): Promise<{ installed: boolean; jobs: CompletedJob[] }> {
  const supabase = await createClient();
  const since = new Date(Date.now() - 365 * 86_400_000).toISOString();
  const { data, error } = await supabase
    .from("work_orders")
    .select("id, category, title, truck_id, trailer_id, estimated_hours, labor_hours, assigned_to, completed_at")
    .in("status", ["completed", "closed"])
    .gte("completed_at", since)
    .order("completed_at", { ascending: false })
    .limit(500);
  if (error) {
    if (MISSING.has(error.code ?? "")) return { installed: false, jobs: [] };
    throw new Error(`Could not load completed work orders: ${error.message}`);
  }
  const rows = (data ?? []) as Array<{ id: string; category: string; title: string; truck_id: string | null; trailer_id?: string | null; estimated_hours: number | string | null; labor_hours: number | string | null; assigned_to: string | null; completed_at: string | null }>;
  if (!rows.length) return { installed: true, jobs: [] };
  const ids = rows.map((r) => r.id);
  const [time, trucks, trailers] = await Promise.all([
    supabase.from("work_order_time_entries").select("work_order_id, started_at, ended_at").in("work_order_id", ids).is("voided_at", null).not("ended_at", "is", null),
    supabase.from("trucks").select("id, truck_type"),
    supabase.from("trailers").select("id, trailer_type"),
  ]);
  const minutes = new Map<string, number>();
  for (const t of (time.error ? [] : time.data ?? []) as Array<{ work_order_id: string; started_at: string; ended_at: string }>) {
    minutes.set(t.work_order_id, (minutes.get(t.work_order_id) ?? 0) + (Date.parse(t.ended_at) - Date.parse(t.started_at)) / 60_000);
  }
  const truckType = new Map(((trucks.data ?? []) as Array<{ id: string; truck_type: string }>).map((t) => [t.id, t.truck_type]));
  const trailerType = new Map(((trailers.data ?? []) as Array<{ id: string; trailer_type: string }>).map((t) => [t.id, t.trailer_type]));
  const jobs: CompletedJob[] = [];
  for (const r of rows) {
    const logged = minutes.get(r.id);
    const hours = logged !== undefined && logged > 0 ? logged / 60 : r.labor_hours !== null ? Number(r.labor_hours) : 0;
    if (!(hours > 0)) continue;
    jobs.push({
      id: r.id,
      category: r.category,
      equipment: r.trailer_id ? trailerType.get(r.trailer_id) ?? null : r.truck_id ? truckType.get(r.truck_id) ?? null : null,
      title: r.title,
      hours: Math.round(hours * 100) / 100,
      estimated: r.estimated_hours !== null && r.estimated_hours !== undefined ? Number(r.estimated_hours) : null,
      lead: r.assigned_to,
      completedAt: r.completed_at ?? "",
    });
  }
  return { installed: true, jobs };
}
