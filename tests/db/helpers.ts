// Database test helpers. Tests run against a migrated + seeded database
// (scripts/dev-stack/stack.sh db-reset, or `supabase db reset`).
// Each test runs inside a transaction that is rolled back, impersonating a
// user the same way PostgREST does: SET ROLE authenticated + JWT claims.
import { randomUUID } from "node:crypto";
import pg from "pg";

export const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres@127.0.0.1:54322/postgres";

export const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 6 });

export type Role = "owner" | "office" | "dispatcher" | "mechanic" | "driver" | null;

/** Top Line Trucking — company #1, owner of all seed data. */
export const TOP_LINE = "00000000-0000-4000-8000-000000000001";

export interface Session {
  client: pg.PoolClient;
  /** Run SQL as the given user (or anon when userId is null). */
  as(userId: string | null): Promise<void>;
  /** Run SQL as the database superuser (setup only). */
  asAdmin(): Promise<void>;
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(sql: string, params?: unknown[]): Promise<pg.QueryResult<T>>;
  /**
   * Create an auth user with a membership (default: Top Line). role = null
   * means a membership waiting for a role; membership: false creates none.
   */
  createUser(role: Role, opts?: { active?: boolean; companyId?: string; membership?: boolean }): Promise<string>;
  /** Create a throwaway company (rolled back with the test). */
  createCompany(name: string): Promise<string>;
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
          // A verified two-step session (aal2), as most tests act; tests/db/mfa.test.ts sets aal1 explicitly.
          JSON.stringify({ sub: userId, role: "authenticated", aal: "aal2" }),
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
      await client.query("update public.profiles set full_name = $2 where id = $1", [id, `Test ${role ?? "pending"}`]);
      if (opts.membership !== false) {
        await client.query(
          "insert into public.company_memberships (company_id, user_id, role, active) values ($1, $2, $3, $4)",
          [opts.companyId ?? TOP_LINE, id, role, opts.active ?? true],
        );
      }
      return id;
    },
    async createCompany(name) {
      await client.query("reset role");
      const slug = `test-${randomUUID().slice(0, 8)}`;
      const r = await client.query<{ id: string }>("select private.create_company($1, $2) as id", [name, slug]);
      return r.rows[0].id;
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
  const customer = await s.query<{ id: string }>("select id from customers where name = 'Prairie View Landscaping' and company_id = '00000000-0000-4000-8000-000000000001'");
  const contractCustomer = await s.query<{ id: string }>("select id from customers where name = 'Lakeshore Paving Co.' and company_id = '00000000-0000-4000-8000-000000000001'");
  const gravel = await s.query<{ id: string }>("select id from materials where code = 'GRV-53' and company_id = '00000000-0000-4000-8000-000000000001'");
  const haulTon = await s.query<{ id: string }>("select id from charge_items where code = 'HAUL-TON' and company_id = '00000000-0000-4000-8000-000000000001'");
  const fuel = await s.query<{ id: string }>("select id from charge_items where code = 'FUEL-SC' and company_id = '00000000-0000-4000-8000-000000000001'");
  const discPct = await s.query<{ id: string }>("select id from charge_items where code = 'DISC-PCT' and company_id = '00000000-0000-4000-8000-000000000001'");
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
