// The quote editor previews totals with src/lib/quotes/calc.ts; the database
// computes the authoritative totals. They must always agree.
import { afterAll, describe, expect, it } from "vitest";
import { calculateQuote, type CalcLine, type ChargeKind } from "@/lib/quotes/calc";
import { formatQuantity } from "@/lib/money";
import { pool, sampleIds, saveQuote, withSession } from "./helpers";

afterAll(() => pool.end());

// Small deterministic PRNG so failures are reproducible.
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("TypeScript and database quote calculations agree", () => {
  it("for 40 random quotes", async () => {
    await withSession(async (s) => {
      const ids = await sampleIds(s);
      const owner = await s.createUser("owner");
      await s.as(owner);
      const rand = mulberry32(20261010);
      const int = (max: number) => Math.floor(rand() * max);
      const kinds: ChargeKind[] = ["material", "hauling", "service", "surcharge", "discount", "other"];

      for (let q = 0; q < 40; q++) {
        const lines: CalcLine[] = [];
        const count = 1 + int(8);
        for (let i = 0; i < count; i++) {
          const kind = kinds[int(kinds.length)];
          const percent = kind !== "material" && rand() < 0.25;
          lines.push(
            percent
              ? { kind, calcMethod: "percent_of_subtotal", quantityMilli: null, rateCents: null, percentBp: 1 + int(3000), taxable: rand() < 0.5 }
              : { kind, calcMethod: "per_unit", quantityMilli: 1 + int(50_000_000), rateCents: int(2_000_000), percentBp: null, taxable: rand() < 0.5 },
          );
        }
        const taxBp = int(1000);
        const expected = calculateQuote(lines, taxBp);
        const r = await saveQuote(s, {
          customer_id: ids.customerId,
          tax_rate_bp: taxBp,
          lines: lines.map((l, i) => ({
            kind: l.kind,
            calc_method: l.calcMethod,
            description: `Line ${i + 1}`,
            unit_code: l.calcMethod === "per_unit" ? "ton" : null,
            quantity: l.quantityMilli === null ? null : formatQuantity(l.quantityMilli).replace(/,/g, ""),
            unit_rate_cents: l.rateCents,
            percent_bp: l.percentBp,
            taxable: l.taxable,
          })),
        });
        const v = await s.query("select subtotal_cents, discount_cents, taxable_cents, tax_cents, total_cents from public.quote_versions where id = $1", [r.version_id]);
        const dbLines = await s.query<{ amount_cents: string }>("select amount_cents from public.quote_lines where quote_version_id = $1 order by line_no", [r.version_id]);
        expect(dbLines.rows.map((l) => Number(l.amount_cents)), `quote ${q}`).toEqual(expected.lineAmounts);
        expect({
          subtotal: Number(v.rows[0].subtotal_cents),
          discount: Number(v.rows[0].discount_cents),
          taxable: Number(v.rows[0].taxable_cents),
          tax: Number(v.rows[0].tax_cents),
          total: Number(v.rows[0].total_cents),
        }, `quote ${q}`).toEqual({
          subtotal: expected.subtotalCents,
          discount: expected.discountCents,
          taxable: expected.taxableCents,
          tax: expected.taxCents,
          total: expected.totalCents,
        });
      }
    });
  });
});
