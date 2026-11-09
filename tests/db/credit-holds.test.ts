// Credit holds (B128, 20261120005600): billing puts a customer on hold (reason required) or releases it; the overdue
// and credit-limit rules flag customers from issued invoices; order and dispatch staff see holds (amounts only with
// billing access); going ahead records a reason; other companies see nothing.
import { afterAll, describe, expect, it } from "vitest";
import { handedOff } from "./fixtures";
import { pgError, pool, withSession, withoutPermission } from "./helpers";

afterAll(() => pool.end());

type Hold = { customer_id: string; reasons: string[]; note: string; open_cents: number | null; credit_limit_cents: number | null; oldest_overdue_days: number | null };

describe("credit holds", () => {
  it("manual hold and release, the overdue and credit-limit rules, visibility and recorded overrides", async () => {
    await withSession(async (s) => {
      const office = await s.createUser("office");
      const owner = await s.createUser("owner");
      const dispatcher = await s.createUser("dispatcher");
      const driver = await s.createUser("driver");
      const { order, handoffOrder } = await handedOff(s, office);
      await s.asAdmin();
      const customer = (await s.query<{ c: string }>("select customer_id c from public.orders where id = $1", [order.id])).rows[0].c;
      const holds = async (who: string) => {
        await s.as(who);
        return (await s.query<{ r: Hold[] }>("select public.customer_credit_holds(array[$1]::uuid[]) r", [customer])).rows[0].r;
      };

      // Not on hold to start with.
      expect(await holds(owner)).toEqual([]);

      // Only billing managers hold, release or set limits; a hold needs a reason.
      await s.as(dispatcher);
      expect((await pgError(s.query("select public.set_customer_credit_hold($1, true, 'Late')", [customer]))).code).toBe("42501");
      await s.as(owner);
      expect((await pgError(s.query("select public.set_customer_credit_hold($1, true, ' ')", [customer]))).message).toMatch(/why/);
      await s.query("select public.set_customer_credit_hold($1, true, 'Two invoices 60 days late')", [customer]);
      let h = (await holds(owner))[0];
      expect(h).toMatchObject({ customer_id: customer, reasons: ["manual"], note: "Two invoices 60 days late" });
      expect(h.open_cents).not.toBeNull();
      // Dispatch sees the hold but no amounts; a driver cannot read holds at all.
      h = (await holds(dispatcher))[0];
      expect(h.reasons).toEqual(["manual"]);
      expect([h.open_cents, h.credit_limit_cents, h.oldest_overdue_days]).toEqual([null, null, null]);
      await s.as(driver);
      expect((await pgError(s.query("select public.customer_credit_holds(null)"))).code).toBe("42501");

      // Going ahead needs a reason and the right permission, and is recorded with the hold's reasons.
      await s.as(dispatcher);
      expect((await pgError(s.query("select public.record_credit_override($1, 'assignment', null, '')", [customer]))).message).toMatch(/reason/);
      await s.query("select public.record_credit_override($1, 'assignment', null, 'Owner approved by phone')", [customer]);
      // An order override needs orders.edit (dispatchers have it by default since 2026-11-09: taken away here).
      await withoutPermission(s, "dispatcher", "orders.edit");
      await s.as(dispatcher);
      expect((await pgError(s.query("select public.record_credit_override($1, 'order', null, 'x')", [customer]))).code).toBe("42501");
      await s.asAdmin();
      const o = (await s.query<{ reason: string; hold_reasons: string[]; context: string }>("select reason, hold_reasons, context from public.credit_hold_overrides where customer_id = $1", [customer])).rows;
      expect(o).toEqual([{ reason: "Owner approved by phone", hold_reasons: ["manual"], context: "assignment" }]);

      // Release: nothing left; an override for a customer no longer on hold records nothing.
      await s.as(owner);
      await s.query("select public.set_customer_credit_hold($1, false, '')", [customer]);
      expect(await holds(owner)).toEqual([]);
      await s.as(dispatcher);
      await s.query("select public.record_credit_override($1, 'assignment', null, 'Not needed')", [customer]);
      await s.asAdmin();
      expect((await s.query("select 1 from public.credit_hold_overrides where customer_id = $1", [customer])).rowCount).toBe(1);

      // Rules from issued invoices: over the credit limit, and past due beyond the set days.
      await s.as(owner);
      await s.query("select public.invoicing_save_settings('taviron', 15, '')");
      const inv = (await s.query<{ r: string }>("select public.invoice_create($1) r", [handoffOrder])).rows[0].r;
      await s.query("select public.invoice_issue($1, null)", [inv]);
      await s.query("select public.set_customer_credit_limit($1, 0)", [customer]);
      expect((await holds(owner))[0].reasons).toEqual(["over_limit"]);
      await s.query("select public.set_customer_credit_limit($1, null)", [customer]);
      expect(await holds(owner)).toEqual([]);
      await s.asAdmin();
      await s.query("update public.invoices set due_date = private.company_today(company_id) - 40 where id = $1", [inv]);
      await s.as(owner);
      expect(await holds(owner)).toEqual([]); // rule off by default
      await s.query("select public.credit_hold_save_settings(30)");
      h = (await holds(owner))[0];
      expect(h.reasons).toEqual(["overdue"]);
      expect(h.oldest_overdue_days).toBe(40);
      await s.query("select public.credit_hold_save_settings(60)");
      expect(await holds(owner)).toEqual([]);
      await s.as(dispatcher);
      expect((await pgError(s.query("select public.credit_hold_save_settings(30)"))).code).toBe("42501");

      // Another company sees none of it.
      await s.as(owner);
      await s.query("select public.set_customer_credit_hold($1, true, 'Late')", [customer]);
      const other = await s.createCompany("Credit Other (test)");
      const outsider = await s.createUser("owner", { companyId: other });
      await s.as(outsider);
      expect((await s.query<{ r: Hold[] }>("select public.customer_credit_holds(null) r")).rows[0].r).toEqual([]);
      expect((await pgError(s.query("select public.set_customer_credit_hold($1, false, '')", [customer]))).code).toBe("P0002");
      expect((await s.query("select 1 from public.credit_hold_overrides")).rowCount).toBe(0);
    });
  });

  it("the demo sample is for demo companies only", async () => {
    await withSession(async (s) => {
      const owner = await s.createUser("owner");
      await s.as(owner);
      expect((await pgError(s.query("select public.demo_credit_hold_sample()"))).code).toBe("42501");
    });
  });
});
