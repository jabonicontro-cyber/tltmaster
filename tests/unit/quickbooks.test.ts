// QuickBooks Online (master plan B82, B89): the invoice built from a frozen handoff snapshot (per business, exact
// quantity × rate only, one discount line, references), the totals compared after a send, names and query literals,
// token encryption per connection, and sign-in failures that ask the person to connect again. No call reaches Intuit.
import { describe, expect, it, vi } from "vitest";
import { buildQboInvoice, entitiesOf, qboDisplayName, qboDocNumber, qboLiteral, snapshotTotals, totalDifference } from "@/lib/accounting/qbo";
import type { HandoffSnapshot } from "@/lib/billing/rules";

vi.mock("@/server/env", () => ({
  env: () => ({ QBO_CLIENT_ID: "client-test", QBO_CLIENT_SECRET: "secret-test-value", APP_BASE_URL: "https://app.example.test", SUPABASE_SERVICE_ROLE_KEY: "x" }),
}));
vi.mock("@/server/supabase/admin", () => ({ createAdminClient: () => { throw new Error("not used"); } }));

const STONE = "11111111-1111-4111-8111-111111111111";
const TRUCKING = "22222222-2222-4222-8222-222222222222";

function line(n: number, kind: string, amount: number, extra: Partial<HandoffSnapshot["lines"][number]> = {}): HandoffSnapshot["lines"][number] {
  return {
    line_id: `line-${n}`, line_no: n, kind, calc_method: "quantity", description: `${kind} line`, unit_code: "ton", quantity: null, unit_rate_cents: null,
    percent_bp: null, amount_cents: amount, price_source: "manual", taxable: true, delivered_quantity: null, ...extra,
  };
}

function snapshot(lines: HandoffSnapshot["lines"]): HandoffSnapshot {
  return {
    order: { order_id: "o1", order_number: "ORD-2026-000123", customer_number: "C-1", customer_name: "Fictional Paving: North", project_name: "Lot", customer_po: "PO-7",
      service_start: "2026-10-20", service_end: "2026-10-22", subtotal_cents: 0, discount_cents: 0, tax_cents: 700, total_cents: 10_700 },
    lines,
    tickets: [{ ticket_number: "T-1", order_line_id: "line-1" }, { ticket_number: "T-2", order_line_id: "line-2" }],
  } as unknown as HandoffSnapshot;
}

describe("QuickBooks invoice mapping", () => {
  it("one business: every line, quantity × rate only when exact, discounts as one line, order and ticket references", () => {
    const s = snapshot([
      line(1, "material", 6_000, { quantity: "40", unit_rate_cents: 150 }),
      line(2, "hauling", 4_000, { quantity: "33.3", unit_rate_cents: 120 }), // 39.96 ≠ 40.00 (a minimum charge): amount only
      line(3, "discount", -300), line(4, "discount", -200), line(5, "surcharge", 0),
    ]);
    expect(entitiesOf(s)).toEqual([{ id: null, name: null }]);
    const inv = buildQboInvoice(s, { customerId: "58", itemId: "9" }, "BIL-0042");
    expect(inv).toMatchObject({ CustomerRef: { value: "58" }, DocNumber: "ORD-2026-000123", TxnDate: "2026-10-22" });
    expect(inv.Line).toHaveLength(3);
    expect(inv.Line[0]).toMatchObject({ Amount: 60, SalesItemLineDetail: { ItemRef: { value: "9" }, Qty: 40, UnitPrice: 1.5, ServiceDate: "2026-10-20" } });
    expect(inv.Line[1].SalesItemLineDetail).not.toHaveProperty("Qty");
    expect(inv.Line[1].Amount).toBe(40);
    expect(inv.Line[2]).toEqual({ DetailType: "DiscountLineDetail", Amount: 5, DiscountLineDetail: { PercentBased: false } });
    expect(inv.PrivateNote).toBe("Taviron order ORD-2026-000123, billing batch BIL-0042. PO PO-7. Tickets T-1, T-2");
    expect(snapshotTotals(s)).toEqual({ beforeTax: 9_500, total: 10_700, includesTax: true });
  });

  it("split between businesses: each invoice has only its own lines and tickets, compared before tax", () => {
    const s = snapshot([
      line(1, "material", 6_000, { billing_entity_id: STONE, billing_entity_name: "Stone & Sand" }),
      line(2, "hauling", 4_000, { billing_entity_id: TRUCKING, billing_entity_name: "Trucking" }),
      line(3, "discount", -500, { billing_entity_id: TRUCKING, billing_entity_name: "Trucking" }),
    ]);
    expect(entitiesOf(s)).toEqual([{ id: STONE, name: "Stone & Sand" }, { id: TRUCKING, name: "Trucking" }]);
    const stone = buildQboInvoice(s, { customerId: "1", itemId: "9" }, "B", STONE);
    expect(stone.Line.map((l) => l.Amount)).toEqual([60]);
    expect(stone.PrivateNote).toMatch(/Tickets T-1$/);
    const trucking = buildQboInvoice(s, { customerId: "1", itemId: "9" }, "B", TRUCKING);
    expect(trucking.Line.map((l) => [l.DetailType, l.Amount])).toEqual([["SalesItemLineDetail", 40], ["DiscountLineDetail", 5]]);
    expect(snapshotTotals(s, STONE)).toEqual({ beforeTax: 6_000, total: 6_000, includesTax: false });
    expect(snapshotTotals(s, TRUCKING)).toEqual({ beforeTax: 3_500, total: 3_500, includesTax: false });
  });

  it("names, numbers, query literals and total differences", () => {
    expect(qboDocNumber("  ABCDEFGHIJKLMNOPQRSTUVWXYZ ")).toBe("ABCDEFGHIJKLMNOPQRSTU");
    expect(qboDisplayName(" Fictional Paving: North ")).toBe("Fictional Paving- North");
    expect(qboLiteral("O'Brien \\ Sons")).toBe("'O\\'Brien \\\\ Sons'");
    expect(totalDifference(10_700, 10_700)).toBeNull();
    expect(totalDifference(10_700, null)).toBeNull();
    expect(totalDifference(10_700, 10_000)).toBe("QuickBooks shows $100.00; Taviron's total is $107.00. Check the tax on the invoice in QuickBooks.");
  });
});

describe("QuickBooks connection", () => {
  it("encrypts tokens per connection: another connection's key cannot open them, and tampering is detected", async () => {
    const { encryptTokens, decryptTokens } = await import("@/server/accounting/qbo");
    const tokens = { access_token: "access-abc", refresh_token: "refresh-xyz", expires_in: 3600 };
    const sealed = encryptTokens("conn-a", tokens);
    expect(sealed).toMatch(/^v1\./);
    expect(sealed).not.toContain("refresh-xyz");
    expect(encryptTokens("conn-a", tokens)).not.toBe(sealed); // a fresh IV every time
    expect(decryptTokens("conn-a", sealed)).toEqual(tokens);
    expect(() => decryptTokens("conn-b", sealed)).toThrow();
    const [v, iv, tag, body] = sealed.split(".");
    const flipped = Buffer.from(body, "base64");
    flipped[0] ^= 1;
    expect(() => decryptTokens("conn-a", [v, iv, tag, flipped.toString("base64")].join("."))).toThrow();
  });

  it("asks to connect again when Intuit refuses the code, without the secret in the error; builds the sign-in link", async () => {
    const q = await import("@/server/accounting/qbo");
    const calls: Array<{ url: string; init: RequestInit }> = [];
    q.setQboFetchForTests((async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
    }) as unknown as typeof fetch);
    const e = await q.exchangeCode("bad-code").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(q.QboReconnectError);
    expect(String((e as Error).message)).not.toContain("secret-test-value");
    expect(calls[0].url).toBe("https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer");
    expect(String(calls[0].init.body)).toContain("redirect_uri=https%3A%2F%2Fapp.example.test%2Fapi%2Faccounting%2Fqbo%2Fcallback");

    const u = new URL(q.authorizeUrl("state-1"));
    expect(u.origin + u.pathname).toBe("https://appcenter.intuit.com/connect/oauth2");
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ client_id: "client-test", response_type: "code", scope: "com.intuit.quickbooks.accounting", state: "state-1" });
    expect(u.toString()).not.toContain("secret-test-value");
  });
});
