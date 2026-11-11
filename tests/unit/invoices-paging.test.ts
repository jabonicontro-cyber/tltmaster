import { beforeEach, describe, expect, it, vi } from "vitest";

// Money owed, receivables aging and the accountant's year are totals over every invoice. The API returns at most 1000
// rows per request, so the invoice list used to stop at the newest 1000: past that, an old unpaid invoice dropped out of
// money owed and aging. listInvoices now reads every page.

vi.mock("server-only", () => ({}));
let total = 0;
const ranges: Array<[number, number]> = [];
let failWith: { code: string; message: string } | null = null;
const client = {
  from: () => {
    const q = {
      select: () => q,
      order: () => q,
      range: (from: number, to: number) => {
        ranges.push([from, to]);
        if (failWith) return Promise.resolve({ data: null, error: failWith });
        const n = Math.max(0, Math.min(to, total - 1) - from + 1);
        const data = Array.from({ length: n }, (_, k) => ({
          id: `i${from + k}`, status: "issued", total_cents: "1000", subtotal_cents: "1000", discount_cents: "0", tax_cents: "0",
          bill_to: { name: "Acme" }, due_date: "2026-01-01", invoice_payments: [],
        }));
        return Promise.resolve({ data, error: null });
      },
    };
    return q;
  },
};
vi.mock("@/server/supabase/server", () => ({ createClient: async () => client }));

const { listInvoices } = await import("@/server/data/invoices");

describe("listInvoices reads every invoice, not only the newest 1000", () => {
  beforeEach(() => {
    ranges.length = 0;
    failWith = null;
  });

  it("pages past 1000 and stops at the first short page", async () => {
    total = 2345;
    const all = await listInvoices();
    expect(all).toHaveLength(2345);
    expect(new Set(all!.map((i) => i.id)).size).toBe(2345);
    expect(ranges).toEqual([[0, 999], [1000, 1999], [2000, 2999]]);
  });

  it("an exact multiple of the page size reads one more (empty) page and returns them all", async () => {
    total = 1000;
    expect(await listInvoices()).toHaveLength(1000);
    expect(ranges).toHaveLength(2);
  });

  it("before invoicing is installed it says so (null); any other error fails instead of returning part of the list", async () => {
    failWith = { code: "PGRST205", message: "missing" };
    expect(await listInvoices()).toBeNull();
    failWith = { code: "57014", message: "timeout" };
    await expect(listInvoices()).rejects.toThrow("Invoices: timeout");
  });
});
