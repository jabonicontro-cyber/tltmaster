import { describe, expect, it } from "vitest";
import { customerSchema, withoutBrokerFields } from "@/lib/schemas/customer";

// Freight brokers (MK2, 20261120009600): the MC number is kept as digits, however it is typed.
const base = { name: "Lakeshore Logistics (test)", customer_type: "commercial", price_list_id: "" };

describe("broker customers", () => {
  it("reads the MC number however it is typed, and refuses anything else", () => {
    for (const [typed, kept] of [["MC-123456", "123456"], ["mc# 0042", "0042"], ["1234567", "1234567"], ["", ""]]) {
      const r = customerSchema.safeParse({ ...base, is_broker: "on", mc_number: typed });
      expect(r.success && r.data.mc_number).toBe(kept);
    }
    expect(customerSchema.safeParse({ ...base, mc_number: "DOT 12" }).success).toBe(false);
    expect(customerSchema.safeParse({ ...base, mc_number: "123456789" }).success).toBe(false);
    const plain = customerSchema.parse(base);
    expect([plain.is_broker, plain.mc_number]).toEqual([false, ""]);
  });

  it("can be saved without the broker fields before the database has them", () => {
    const row = withoutBrokerFields({ name: "x", is_broker: false, mc_number: "" });
    expect(row).toEqual({ name: "x" });
  });
});
