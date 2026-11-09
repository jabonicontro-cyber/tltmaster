// Invoice "Mark as sent" by hand (migration 20261120011200): billing.manage records an issued invoice as sent by mail,
// own email or handed over, with no delivery proof and never as emailed; once only; drafts, voids, other roles and other
// companies are refused. The proof guard (SEC2 L2) still refuses an email send without a proof, even after a manual mark.
// Fictional data, rolled back.
import { afterAll, describe, expect, it } from "vitest";
import { handedOff } from "./fixtures";
import { pgError, pool, withDeliveryProof, withSession } from "./helpers";

afterAll(() => pool.end());

type Sent = { sent_at: string | null; sent_to: string[]; sent_via: string | null; sent_how: string };

describe("invoice mark as sent", () => {
  it("records a person's own send without a proof, never as an email", async () => {
    await withSession(async (s) => {
      const office = await s.createUser("office");
      const owner = await s.createUser("owner");
      const dispatcher = await s.createUser("dispatcher");
      const { handoffOrder } = await handedOff(s, office);
      await s.as(owner);
      await s.query("select public.invoicing_save_settings('taviron', 15, '')");
      const inv = (await s.query<{ r: string }>("select public.invoice_create($1) r", [handoffOrder])).rows[0].r;
      const sent = async () => (await s.query<Sent>("select sent_at, sent_to, sent_via, sent_how from public.invoices where id = $1", [inv])).rows[0];

      // A draft cannot be marked; the way it was sent is required.
      expect((await pgError(s.query("select public.invoice_mark_sent($1, 'mail')", [inv]))).message).toMatch(/Only an issued invoice/);
      await s.query("select public.invoice_issue($1, null)", [inv]);
      expect((await pgError(s.query("select public.invoice_mark_sent($1, 'fax')", [inv]))).code).toBe("22023");
      expect((await pgError(s.query("select public.invoice_mark_sent($1, null)", [inv]))).code).toBe("22023");

      // Without billing.manage: refused.
      await s.as(dispatcher);
      expect((await pgError(s.query("select public.invoice_mark_sent($1, 'mail')", [inv]))).code).toBe("42501");

      // A direct write cannot borrow the manual path: no grant, and the guard wants a proof without the function's mark.
      await s.as(owner);
      expect((await pgError(s.query("update public.invoices set sent_at = now(), sent_via = 'manual', sent_how = 'mail' where id = $1", [inv]))).code).toBe("42501");
      await s.query("select set_config('taviron.invoice_manual_send', $1, true)", [inv]);
      expect((await pgError(s.query("select public.invoice_record_sent($1, array['ap@example.test'], false)", [inv]))).message).toMatch(/not confirmed/);
      await s.query("select set_config('taviron.invoice_manual_send', '', true)");

      // Marked by hand: sent, by mail, no addresses, no proof needed; history says "by hand", not "emailed".
      expect((await s.query<{ r: boolean }>("select public.invoice_mark_sent($1, 'mail') r", [inv])).rows[0].r).toBe(true);
      const row = await sent();
      expect(row.sent_at).not.toBeNull();
      expect(row).toMatchObject({ sent_to: [], sent_via: "manual", sent_how: "mail" });
      // Idempotent: a second mark changes nothing.
      expect((await s.query<{ r: boolean }>("select public.invoice_mark_sent($1, 'own_email') r", [inv])).rows[0].r).toBe(false);
      expect((await sent()).sent_how).toBe("mail");
      await s.asAdmin();
      const log = (await s.query<{ action: string; summary: string }>("select action, summary from public.audit_events where entity_id = $1 and action like 'invoice.%sent'", [inv])).rows;
      expect(log).toHaveLength(1);
      expect(log[0].action).toBe("invoice.marked_sent");
      expect(log[0].summary).toMatch(/marked as sent by hand \(by mail\); Taviron did not email it/);

      // An email send afterwards still needs its proof (the manual mark is no way around the guard), and is then email.
      await s.as(owner);
      expect((await pgError(s.query("select public.invoice_record_sent($1, array['ap@example.test'], false)", [inv]))).message).toMatch(/not confirmed/);
      const company = (await s.query<{ c: string }>("select company_id c from public.invoices where id = $1", [inv])).rows[0].c;
      await withDeliveryProof(s, company, "invoice.sent", inv);
      await s.query("select public.invoice_record_sent($1, array['ap@example.test'], false)", [inv]);
      await s.query("select set_config('request.headers', '', true)");
      expect(await sent()).toMatchObject({ sent_to: ["ap@example.test"], sent_via: "email", sent_how: "" });

      // Another company's owner cannot find it; a void invoice cannot be marked.
      const other = await s.createCompany("Mark Sent Other Co");
      const outsider = await s.createUser("owner", { companyId: other });
      await s.as(outsider);
      expect((await pgError(s.query("select public.invoice_mark_sent($1, 'mail')", [inv]))).code).toBe("P0002");
      await s.as(owner);
      await s.query("select public.invoice_void($1, 'Test void')", [inv]);
      expect((await pgError(s.query("select public.invoice_mark_sent($1, 'handed_over')", [inv]))).message).toMatch(/Only an issued invoice/);
    });
  });
});
