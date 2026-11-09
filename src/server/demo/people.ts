import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Save the People records of demo people. Every driver already has one once the driver is saved (the database adds
 * it, migration 20261120010000: Fleet and People are one list), so a row with a driver_id fills in that record
 * (job title, department, hire date, avatar...) and the other rows are inserted. Works the same on a database without
 * that migration (no record yet: the row is inserted). Returns each row's id and name, in the order given.
 */
export async function savePeople(db: SupabaseClient, rows: ReadonlyArray<Record<string, unknown> & { full_name: string; driver_id?: string | null }>): Promise<Array<{ id: string; full_name: string }>> {
  const driverIds = rows.map((r) => r.driver_id).filter((v): v is string => typeof v === "string");
  const existing = new Map<string, string>();
  if (driverIds.length) {
    const r = await db.from("employees").select("id, driver_id").in("driver_id", driverIds);
    if (r.error) throw new Error(`Demo setup failed (people): ${r.error.message}`);
    for (const e of (r.data ?? []) as Array<{ id: string; driver_id: string }>) existing.set(e.driver_id, e.id);
  }
  const out: Array<{ id: string; full_name: string } | null> = rows.map(() => null);
  const inserts: number[] = [];
  for (const [i, row] of rows.entries()) {
    const id = row.driver_id ? existing.get(row.driver_id) : undefined;
    if (!id) {
      inserts.push(i);
      continue;
    }
    // The login stays as the database linked it unless the row names one.
    const { user_id, ...rest } = row;
    const r = await db.from("employees").update(user_id ? { ...rest, user_id } : rest).eq("id", id);
    if (r.error) throw new Error(`Demo setup failed (people): ${r.error.message}`);
    out[i] = { id, full_name: row.full_name };
  }
  if (inserts.length) {
    const r = await db.from("employees").insert(inserts.map((i) => rows[i])).select("id, full_name");
    if (r.error) throw new Error(`Demo setup failed (people): ${r.error.message}`);
    const made = (r.data ?? []) as Array<{ id: string; full_name: string }>;
    inserts.forEach((rowIndex, k) => { out[rowIndex] = made[k] ?? null; });
  }
  return out.filter((x): x is { id: string; full_name: string } => x !== null);
}
