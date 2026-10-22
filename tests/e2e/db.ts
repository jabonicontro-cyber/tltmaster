import pg from "pg";

/**
 * Run SQL as an e2e user (same impersonation PostgREST uses) to create
 * fixtures through the app's own database functions and RLS. Local only.
 */
export async function asUser<T>(email: string, fn: (q: (sql: string, params?: unknown[]) => Promise<pg.QueryResult>) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await client.connect();
  try {
    await client.query("begin");
    const { rows } = await client.query<{ id: string }>("select id from public.profiles where email = $1", [email]);
    if (!rows[0]) throw new Error(`No e2e user ${email}`);
    await client.query("set local role authenticated");
    await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: rows[0].id, role: "authenticated" })]);
    const result = await fn((sql, params) => client.query(sql, params as unknown[]));
    await client.query("commit");
    return result;
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    await client.end();
  }
}

/**
 * A real (non-sample) active material for order fixtures. The seed's materials are all sample data, so on a freshly
 * built database the first spec that needs one creates it instead of relying on another spec having run first.
 */
export async function realMaterial(q: (sql: string, params?: unknown[]) => Promise<pg.QueryResult>): Promise<{ id: string; unit: string }> {
  const found = (await q("select id, default_unit_code as unit from public.materials where active and not is_sample order by code limit 1")).rows[0];
  if (found) return found as { id: string; unit: string };
  return (await q("insert into public.materials (code, name, default_unit_code) values ('E2E-BASE', 'Base material (test)', 'ton') returning id, default_unit_code as unit")).rows[0] as { id: string; unit: string };
}
