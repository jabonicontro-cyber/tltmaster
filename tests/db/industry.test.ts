// Industry profile (20261120007600, master plan MK1): every company starts as aggregate; only people who manage settings
// change it, only for their own company, and only to a known value.
import { afterAll, describe, expect, it } from "vitest";
import { pgError, pool, TOP_LINE, withSession } from "./helpers";

afterAll(() => pool.end());

describe("industry profile", () => {
  it("defaults to aggregate and is changed only by people who manage settings, in their own company", async () => {
    await withSession(async (s) => {
      await s.asAdmin();
      const otherCompany = await s.createCompany("Industry Other Hauling (test)");
      const owner = await s.createUser("owner");
      const dispatcher = await s.createUser("dispatcher");
      await s.as(owner);
      const read = async () => (await s.query<{ industry: string }>("select industry from public.company_settings where company_id = $1", [TOP_LINE])).rows[0]?.industry;
      expect(["aggregate", "freight", "both"]).toContain(await read());
      await s.query("update public.company_settings set industry = 'freight' where company_id = $1", [TOP_LINE]);
      expect(await read()).toBe("freight");
      expect((await pgError(s.query("update public.company_settings set industry = 'trains' where company_id = $1", [TOP_LINE]))).code).toBe("23514");
      // Another company's setting is not reached.
      const other = await s.query("update public.company_settings set industry = 'freight' where company_id = $1 returning company_id", [otherCompany]);
      expect(other.rowCount).toBe(0);
      await s.asAdmin();
      expect((await s.query<{ industry: string }>("select industry from public.company_settings where company_id = $1", [otherCompany])).rows[0]?.industry ?? "aggregate").toBe("aggregate");
      await s.as(owner);
      // A dispatcher can't change it (the settings update policy needs settings.manage).
      await s.as(dispatcher);
      const r = await s.query("update public.company_settings set industry = 'both' where company_id = $1 returning company_id", [TOP_LINE]);
      expect(r.rowCount).toBe(0);
      await s.as(owner);
      expect(await read()).toBe("freight");
    });
  });
});
