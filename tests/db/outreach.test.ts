// Outreach (20261120007500, master plan B139): the platform team's prospect list. Platform team only; an address that
// asked not to be contacted is never added again and no email can be prepared for it; unsubscribe works only through
// the service role with the prospect's own token; an interested prospect becomes one lead.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { pgError, pool, withSession, type Session } from "./helpers";

afterAll(() => pool.end());

const service = (s: Session) => s.query("set local role service_role");
async function platformAdmin(s: Session) {
  const id = await s.createUser(null, { membership: false });
  await s.asAdmin();
  const email = (await s.query<{ email: string }>("select email from auth.users where id = $1", [id])).rows[0].email;
  await service(s);
  await s.query("select public.platform_admin_grant($1, 'test')", [email]);
  await s.asAdmin();
  await s.as(id);
  return id;
}
const tag = () => randomUUID().slice(0, 8);
const row = (email: string, extra: Record<string, unknown> = {}) => ({ email, company_name: `Outreach Hauling ${tag()} (test)`, state: "TX", power_units: "12", segment: "aggregate", ...extra });
const importRows = async (s: Session, rows: unknown[], source = "fmcsa_census") =>
  (await s.query<{ r: { added: number; updated: number; suppressed: number; invalid: number } }>("select public.platform_outreach_import($1::jsonb, $2) as r", [JSON.stringify(rows), source])).rows[0].r;
const find = async (s: Session, email: string) =>
  (await s.query<{ r: { rows: Array<{ id: string; status: string; unsubscribe_token: string; power_units: number | null; contact_name: string }> } }>(
    "select public.platform_outreach_list($1, '', '', '', null, null, 10, 0) as r", [email])).rows[0].r.rows[0];

describe("outreach", () => {
  it("is for the platform team only", async () => {
    await withSession(async (s) => {
      const owner = await s.createUser("owner");
      await s.as(owner);
      for (const sql of ["select public.platform_outreach_list('', '', '', '', null, null, 10, 0)", "select public.platform_outreach_settings()",
                         "select public.platform_outreach_import('[]'::jsonb, 'csv')", `select public.platform_outreach_convert('${randomUUID()}')`]) {
        expect((await pgError(s.query(sql))).code, sql).toBe("42501");
      }
      // The unsubscribe function is not callable by a signed-in person either (service role only).
      expect((await pgError(s.query("select public.outreach_unsubscribe($1)", ["a".repeat(32)]))).code).toBe("42501");
      // The tables are not readable directly.
      expect((await pgError(s.query("select * from private.outreach_prospects"))).code).toBe("42501");
    });
  });

  it("adds each address once, fills only empty details later, and refuses bad rows", async () => {
    await withSession(async (s) => {
      await platformAdmin(s);
      const email = `dispatch-${tag()}@hauling.example`;
      expect(await importRows(s, [row(email.toUpperCase()), row("not-an-email"), { email: `x-${tag()}@a.example`, company_name: "" }]))
        .toEqual({ added: 1, updated: 0, suppressed: 0, invalid: 2 });
      expect(await importRows(s, [row(email, { contact_name: "Jo Smith", power_units: "99" })])).toEqual({ added: 0, updated: 1, suppressed: 0, invalid: 0 });
      const p = await find(s, email);
      expect([p.status, p.contact_name, p.power_units]).toEqual(["new", "Jo Smith", 12]); // power units kept, contact filled
      expect(p.unsubscribe_token).toMatch(/^[0-9a-f]{32}$/);
      expect((await pgError(importRows(s, Array.from({ length: 1001 }, () => ({}))))).message).toMatch(/at most 1000/);
    });
  });

  it("records sending, turns an interested company into one lead, and never contacts an address that asked not to be", async () => {
    await withSession(async (s) => {
      await platformAdmin(s);
      const email = `office-${tag()}@hauling.example`;
      await importRows(s, [row(email)]);
      const p = await find(s, email);
      await s.query("select public.platform_outreach_record($1, 'marked_sent')", [p.id]);
      expect((await find(s, email)).status).toBe("contacted");
      const lead = (await s.query<{ id: string }>("select public.platform_outreach_convert($1) as id", [p.id])).rows[0].id;
      expect((await s.query<{ id: string }>("select public.platform_outreach_convert($1) as id", [p.id])).rows[0].id).toBe(lead);
      await s.asAdmin();
      const l = (await s.query<{ email: string; status: string; truck_count: number }>("select email, status, truck_count from private.leads where id = $1", [lead])).rows[0];
      expect(l).toEqual({ email, status: "contacted", truck_count: 12 });

      // Unsubscribe from the email link (service role, the prospect's own token).
      const other = `owner-${tag()}@hauling.example`;
      const admin = await platformAdmin(s);
      await importRows(s, [row(other)]);
      const q = await find(s, other);
      await service(s);
      expect((await s.query<{ r: { ok: boolean } }>("select public.outreach_unsubscribe($1) as r", ["0".repeat(32)])).rows[0].r.ok).toBe(false);
      expect((await s.query<{ r: { ok: boolean } }>("select public.outreach_unsubscribe($1) as r", [q.unsubscribe_token])).rows[0].r.ok).toBe(true);
      await s.asAdmin();
      await s.as(admin);
      expect((await find(s, other)).status).toBe("do_not_contact");
      expect((await pgError(s.query("select public.platform_outreach_record($1, 'prepared')", [q.id]))).code).toBe("42501");
      expect((await pgError(s.query("select public.platform_outreach_update($1, 'new', null)", [q.id]))).code).toBe("42501");
      expect((await pgError(s.query("select public.platform_outreach_convert($1)", [q.id]))).code).toBe("42501");
      // Importing the address again does not bring it back.
      expect(await importRows(s, [row(other)])).toMatchObject({ added: 0, updated: 0, suppressed: 1 });
    });
  });

  it("saves the email settings with checks", async () => {
    await withSession(async (s) => {
      await platformAdmin(s);
      const save = (p: Record<string, unknown>) => s.query("select public.platform_outreach_settings_save($1::jsonb)", [JSON.stringify(p)]);
      await save({ sender_name: "Jordan Lee", postal_address: "PO Box 100, Waco, TX 76701", subject: "Hi", body: "Hello", faq: [{ q: "Q", a: "A" }] });
      const r = (await s.query<{ r: { sender_name: string; faq: unknown[] } }>("select public.platform_outreach_settings() as r")).rows[0].r;
      expect([r.sender_name, r.faq.length]).toEqual(["Jordan Lee", 1]);
      expect((await pgError(save({ reply_to: "nope", faq: [] }))).message).toMatch(/valid reply-to/);
      expect((await pgError(save({ faq: Array.from({ length: 13 }, () => ({ q: "q", a: "a" })) }))).message).toMatch(/Up to 12/);
    });
  });
});
