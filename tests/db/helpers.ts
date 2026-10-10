// Database test helpers. Tests run against a migrated + seeded database
// (scripts/dev-stack/stack.sh db-reset, or `supabase db reset`).
// Each test runs inside a transaction that is rolled back, impersonating a
// user the same way PostgREST does: SET ROLE authenticated + JWT claims.
import { randomUUID } from "node:crypto";
import pg from "pg";

export const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres@127.0.0.1:54322/postgres";

export const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 6 });

export type Role = "owner" | "office" | "dispatcher" | "driver" | null;

export interface Session {
  client: pg.PoolClient;
  /** Run SQL as the given user (or anon when userId is null). */
  as(userId: string | null): Promise<void>;
  /** Run SQL as the database superuser (setup only). */
  asAdmin(): Promise<void>;
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(sql: string, params?: unknown[]): Promise<pg.QueryResult<T>>;
  createUser(role: Role, opts?: { active?: boolean }): Promise<string>;
}

export async function withSession(fn: (s: Session) => Promise<void>): Promise<void> {
  const client = await pool.connect();
  await client.query("begin");
  const session: Session = {
    client,
    async as(userId) {
      await client.query("reset role");
      if (userId) {
        await client.query("set local role authenticated");
        await client.query("select set_config('request.jwt.claims', $1, true)", [
          JSON.stringify({ sub: userId, role: "authenticated" }),
        ]);
      } else {
        await client.query("set local role anon");
        await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "anon" })]);
      }
    },
    async asAdmin() {
      await client.query("reset role");
      await client.query("select set_config('request.jwt.claims', '', true)");
    },
    // Each statement runs in a savepoint so an expected failure does not
    // abort the surrounding test transaction.
    async query(sql, params) {
      await client.query("savepoint stmt");
      try {
        const res = await client.query(sql, params as unknown[]);
        await client.query("release savepoint stmt");
        return res;
      } catch (e) {
        await client.query("rollback to savepoint stmt");
        throw e;
      }
    },
    async createUser(role, opts = {}) {
      const id = randomUUID();
      await client.query("reset role");
      await client.query(
        "insert into auth.users (id, email, aud, role) values ($1, $2, 'authenticated', 'authenticated')",
        [id, `${role ?? "pending"}-${id.slice(0, 8)}@test.example`],
      );
      await client.query("update public.profiles set role = $2, active = $3, full_name = $4 where id = $1", [
        id,
        role,
        opts.active ?? true,
        `Test ${role ?? "pending"}`,
      ]);
      return id;
    },
  };
  try {
    await fn(session);
  } finally {
    await client.query("rollback");
    client.release();
  }
}

/** Expect a promise to reject with a Postgres error; returns the error. */
export async function pgError(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await p;
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return { code: err.code ?? "", message: err.message ?? "" };
  }
  throw new Error("Expected the query to fail, but it succeeded");
}

export async function sampleIds(s: Session) {
  await s.asAdmin();
  const customer = await s.query<{ id: string }>("select id from customers where name = 'Prairie View Landscaping'");
  const contractCustomer = await s.query<{ id: string }>("select id from customers where name = 'Lakeshore Paving Co.'");
  const gravel = await s.query<{ id: string }>("select id from materials where code = 'GRV-53'");
  const haulTon = await s.query<{ id: string }>("select id from charge_items where code = 'HAUL-TON'");
  const fuel = await s.query<{ id: string }>("select id from charge_items where code = 'FUEL-SC'");
  const discPct = await s.query<{ id: string }>("select id from charge_items where code = 'DISC-PCT'");
  return {
    customerId: customer.rows[0].id,
    contractCustomerId: contractCustomer.rows[0].id,
    gravelId: gravel.rows[0].id,
    haulTonId: haulTon.rows[0].id,
    fuelId: fuel.rows[0].id,
    discountPctId: discPct.rows[0].id,
  };
}

export interface LineInput {
  kind: string;
  calc_method: string;
  material_id?: string | null;
  charge_item_id?: string | null;
  description: string;
  unit_code?: string | null;
  quantity?: string | null;
  unit_rate_cents?: number | null;
  percent_bp?: number | null;
  taxable?: boolean;
}

export async function saveQuote(s: Session, payload: Record<string, unknown>) {
  const res = await s.query<{ r: { quote_id: string; version_id: string; edit_seq: number; total_cents: number; quote_number: string; version_no: number } }>(
    "select public.save_quote_draft($1::jsonb) as r",
    [JSON.stringify(payload)],
  );
  return res.rows[0].r;
}
