// Reference numbers (20261120001300; docs/REFERENCE_NUMBERS.md): new companies number ORD-1001, QTE-1001, TKT-1001,
// BIL-1001, CUS-1001, MWO-1001; concurrent requests never get the same number; a used number is never reissued (even
// after the format is changed back); the next number cannot be lowered by hand; references are searchable however
// they are typed; companies are numbered independently.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { pgError, pool, TOP_LINE, withSession } from "./helpers";

afterAll(() => pool.end());

describe("reference numbers", () => {
  it("a new company gets the readable standard, numbered from 1001 per record type, independently of others", async () => {
    await withSession(async (s) => {
      const a = await s.createCompany(`Ref A ${randomUUID().slice(0, 6)}`);
      const b = await s.createCompany(`Ref B ${randomUUID().slice(0, 6)}`);
      await s.asAdmin();
      const seq = (await s.query<{ key: string; prefix: string; include_year: boolean; pad: number; next_value: string }>(
        "select key, prefix, include_year, pad, next_value from public.document_sequences where company_id = $1 order by key", [a])).rows;
      expect(seq.map((r) => `${r.key}:${r.prefix}:${r.include_year}:${r.pad}:${r.next_value}`)).toEqual([
        "billing:BIL-:false:4:1001", "customer:CUS-:false:4:1001", "order:ORD-:false:4:1001", "quote:QTE-:false:4:1001",
        "ticket:TKT-:false:4:1001", "work_order:MWO-:false:4:1001",
      ]);
      const n = async (c: string, k: string) => (await s.query<{ n: string }>("select private.next_document_number($1, $2) n", [c, k])).rows[0].n;
      expect(await n(a, "order")).toBe("ORD-1001");
      expect(await n(a, "order")).toBe("ORD-1002");
      expect(await n(b, "order")).toBe("ORD-1001");
      expect(await n(a, "ticket")).toBe("TKT-1001");
      expect(await n(a, "work_order")).toBe("MWO-1001");
      // Customers get one through their insert trigger.
      await s.query("insert into public.customers (company_id, name) values ($1, 'Ref Customer')", [a]);
      expect((await s.query<{ c: string }>("select customer_number c from public.customers where company_id = $1", [a])).rows[0].c).toBe("CUS-1001");
    });
  });

  it("a used number is never reissued, even after the format is changed back; the next number cannot be lowered", async () => {
    await withSession(async (s) => {
      const c = await s.createCompany(`Ref C ${randomUUID().slice(0, 6)}`);
      await s.asAdmin();
      await s.query("insert into public.customers (company_id, name) values ($1, 'One'), ($1, 'Two')", [c]);
      // A manual change back to a value already used is refused …
      expect((await pgError(s.query("update public.document_sequences set next_value = 1001 where company_id = $1 and key = 'customer'", [c]))).code).toBe("22023");
      // … and a format change that would produce a used reference skips it.
      await s.query("update public.document_sequences set prefix = 'CUS-', pad = 4 where company_id = $1 and key = 'customer'", [c]);
      await s.query("select set_config('tlt.number_allocation', 'on', true)");
      await s.query("update public.document_sequences set next_value = 1001 where company_id = $1 and key = 'customer'", [c]);
      await s.query("select set_config('tlt.number_allocation', 'off', true)");
      await s.query("insert into public.customers (company_id, name) values ($1, 'Three')", [c]);
      const nums = (await s.query<{ n: string }>("select customer_number n from public.customers where company_id = $1 order by created_at, customer_number", [c])).rows.map((r) => r.n);
      expect(new Set(nums).size).toBe(3);
      expect(nums).toContain("CUS-1003");
    });
  });

  it("concurrent requests are serialized: two connections never receive the same number", async () => {
    const company = TOP_LINE;
    const a = await pool.connect();
    const b = await pool.connect();
    try {
      await a.query("begin");
      await b.query("begin");
      const first = (await a.query<{ n: string }>("select private.next_document_number($1, 'quote') n", [company])).rows[0].n;
      // B waits on A's row lock; release A after a moment.
      const second = b.query<{ n: string }>("select private.next_document_number($1, 'quote') n", [company]);
      await new Promise((r) => setTimeout(r, 300));
      await a.query("commit");
      const n2 = (await second).rows[0].n;
      await b.query("rollback");
      expect(first).not.toBe(n2);
      expect(first).toMatch(/^QTE-\d{4,}$/);
      expect(n2).toMatch(/^QTE-\d{4,}$/);
    } finally {
      a.release();
      b.release();
    }
  });

  it("a rolled-back transaction gives its number back; search keys ignore case and punctuation", async () => {
    await withSession(async (s) => {
      const c = await s.createCompany(`Ref D ${randomUUID().slice(0, 6)}`);
      await s.asAdmin();
      await s.client.query("savepoint before_number");
      await s.client.query("select private.next_document_number($1, 'billing')", [c]);
      await s.client.query("rollback to savepoint before_number");
      expect((await s.query<{ n: string }>("select private.next_document_number($1, 'billing') n", [c])).rows[0].n).toBe("BIL-1001");
      await s.query("insert into public.customers (company_id, name) values ($1, 'Key Test')", [c]);
      const key = (await s.query<{ k: string }>("select customer_ref_key k from public.customers where company_id = $1", [c])).rows[0].k;
      expect(key).toBe("CUS1001");
      // Legacy references keep their value and get a key too.
      const legacy = (await s.query<{ k: string }>("select order_ref_key k from public.orders where order_number like 'O-%' limit 1")).rows[0];
      if (legacy) expect(legacy.k).toMatch(/^O\d{8}$/);
    });
  });

  it("people only search references inside their own company", async () => {
    await withSession(async (s) => {
      const other = await s.createCompany(`Ref E ${randomUUID().slice(0, 6)}`);
      await s.asAdmin();
      await s.query("insert into public.customers (company_id, name) values ($1, 'Hidden')", [other]);
      const owner = await s.createUser("owner");
      await s.as(owner);
      const seen = (await s.query<{ company_id: string }>("select company_id from public.customers where customer_ref_key like 'CUS%'")).rows;
      expect(seen.every((r) => r.company_id === TOP_LINE)).toBe(true);
      // Changing numbering needs settings.manage.
      const driver = await s.createUser("driver");
      await s.as(driver);
      const upd = await s.query("update public.document_sequences set prefix = 'X-' where key = 'order'");
      expect(upd.rowCount).toBe(0);
    });
  });
});
