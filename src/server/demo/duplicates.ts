import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminAvailable, createAdminClient } from "@/server/supabase/admin";

// Demo duplicate cleanup (owner 2026-11-17; master plan §12 DP2). A race while a prospect demo was first filled (fixed
// since by the refresh lock) left exact copies of some sample customers and people a few seconds apart. Each Refresh
// removes them, keeping the older row:
//   * the database finds them (public.demo_duplicate_samples, 20261120024510): only for the owner of a demo company
//     (refused for a real company), only rows with one of the sample names given here, only exact copies of an older
//     row, and only those nothing points at (every foreign key checked); a copy something points at is left as it is;
//   * the rows are removed here with the service key (demo users have no right to delete customers or people), after
//     checking again that the company is a demo, for exactly the ids the database returned, within that company.
// A second run finds nothing, so it is safe on every Refresh.

type Db = SupabaseClient;

export type DuplicateCleanup = { removed: number; kept: Array<{ kind: "customer" | "person"; name: string }>; notes: string[] };

export async function removeDuplicateSamples(db: Db, names: { customers: readonly string[]; people: readonly string[] }, admin?: Db): Promise<DuplicateCleanup> {
  const out: DuplicateCleanup = { removed: 0, kept: [], notes: [] };
  const found = await db.rpc("demo_duplicate_samples", { p_customers: [...names.customers], p_people: [...names.people] });
  if (found.error) {
    if (found.error.code === "PGRST202" || found.error.code === "42883") return out; // the update is not installed yet
    throw new Error(`Demo duplicate check failed: ${found.error.message}`);
  }
  const r = found.data as { customers: string[]; sites: string[]; people: string[]; kept: Array<{ kind: "customer" | "person"; name: string }> };
  out.kept = r.kept ?? [];
  for (const k of out.kept) out.notes.push(`A copy of the sample ${k.kind} ${k.name} has records of its own and was left as it is.`);
  if (!r.customers.length && !r.people.length) return out;
  if (!admin && !adminAvailable()) {
    out.notes.push("Duplicate sample rows were found but cannot be removed on this server (no service key).");
    return out;
  }
  const svc = admin ?? createAdminClient();
  // The company again, from the signed-in person: it must be a demo (the database already refused anything else).
  const { data: me } = await db.rpc("my_access");
  const companyId = (me as { company_id?: string | null } | null)?.company_id;
  if (!companyId) return out;
  const { data: company } = await svc.from("companies").select("is_demo").eq("id", companyId).maybeSingle();
  if (!(company as { is_demo?: boolean } | null)?.is_demo) throw new Error("Duplicate sample rows are only removed from demo companies.");

  const remove = async (table: "customers" | "employees", ids: string[]) => {
    if (!ids.length) return 0;
    const { data, error } = await svc.from(table).delete().eq("company_id", companyId).in("id", ids).select("id");
    if (error) {
      // Something started pointing at it since it was checked (a foreign key refuses): leave it.
      out.notes.push(`Some duplicate sample rows could not be removed (${table}): ${error.message}`);
      return 0;
    }
    return (data ?? []).length;
  };
  // One statement per table: a customer's copied job sites (checked unused above) go with it (their foreign key cascades).
  out.removed += await remove("customers", r.customers);
  out.removed += await remove("employees", r.people);
  return out;
}

/** The cleanup's lines for the refresh summary (nothing when there was nothing to do). */
export function duplicateNotes(r: DuplicateCleanup): string[] {
  return [...(r.removed ? [`Removed ${r.removed} duplicate sample ${r.removed === 1 ? "record" : "records"} (kept the older one of each).`] : []), ...r.notes];
}
