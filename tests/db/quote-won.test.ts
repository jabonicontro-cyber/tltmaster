// Quotes only (MOD1 (3), migration 20261120023200, docs/MODULES.md §6): an accepted quote is won (who, when), makes
// no order, and cannot be converted while Orders is switched off; switched back on, it converts with one click.
import { afterAll, describe, expect, it } from "vitest";
import { addDays } from "@/lib/dates";
import { businessToday } from "./fixtures";
import { pgError, pool, sampleIds, saveQuote, TOP_LINE, withSession } from "./helpers";

afterAll(() => pool.end());

describe("quotes without orders", () => {
  it("records who won the quote, makes no order, and converts only once Orders is on", async () => {
    await withSession(async (s) => {
      const owner = await s.createUser("owner");
      const ids = await sampleIds(s);
      const today = await businessToday(s);
      await s.as(owner);
      await s.query("select public.set_company_modules(private.module_preset('quotes_only'))");

      const q = await saveQuote(s, {
        customer_id: ids.customerId, quote_date: today, valid_until: addDays(today, 30), tax_rate_bp: 0,
        site_line1: "12 Quote Only Rd (test)",
        lines: [{ kind: "material", calc_method: "per_unit", material_id: ids.gravelId, description: "Gravel #53", unit_code: "ton", quantity: "40", unit_rate_cents: 1000, taxable: false }],
      });
      await s.query("select public.mark_quote_sent($1, $2, 'Handed over (test)')", [q.quote_id, q.edit_seq]);
      await s.query("select public.set_quote_status($1, 'accepted', 'Signed (test)')", [q.quote_id]);

      const won = (await s.query<{ status: string; accepted_by: string; accepted_at: string | null }>("select status, accepted_by, accepted_at from public.quotes where id = $1", [q.quote_id])).rows[0];
      expect(won.status).toBe("accepted");
      expect(won.accepted_by).toBe(owner);
      expect(won.accepted_at).not.toBeNull();
      // No order was made, and none can be while Orders is off.
      expect((await s.query("select 1 from public.orders where company_id = $1 and created_by = $2", [TOP_LINE, owner])).rowCount).toBe(0);
      const refused = await pgError(s.query("select public.convert_quote_to_order($1)", [q.quote_id]));
      expect(refused.code).toBe("42501");
      expect(refused.message).toMatch(/Orders are switched off/);
      expect((await s.query("select 1 from public.orders where source_quote_id = $1", [q.quote_id])).rowCount).toBe(0);

      // Orders switched on: the same quote becomes an order with one click.
      await s.query("select public.set_company_modules('{}')");
      const r = (await s.query<{ r: { order_id: string; created: boolean } }>("select public.convert_quote_to_order($1) as r", [q.quote_id])).rows[0].r;
      expect(r.created).toBe(true);
      expect((await s.query("select 1 from public.orders where source_quote_id = $1", [q.quote_id])).rowCount).toBe(1);
    });
  });
});
