import { describe, expect, it } from "vitest";
import type { Permission } from "@/lib/permissions";
import { intentHits } from "@/lib/search-intents";

const all = () => true;
const only = (...ps: Permission[]) => (p: Permission) => ps.includes(p);

describe("search intents", () => {
  it("understands everyday phrases", () => {
    expect(intentHits("overdue invoices", all)[0].href).toBe("/billing/invoices?view=overdue");
    expect(intentHits("who owes us money", all)[0].title).toBe("Overdue invoices");
    expect(intentHits("trucks down", all)[0].href).toBe("/fleet/trucks?status=out_of_service");
    expect(intentHits("what if I add a truck", all)[0].href).toBe("/reports/what-if");
    expect(intentHits("where is truck 101", all)[0].href).toBe("/fleet/locations");
    expect(intentHits("unbilled loads", all)[0].href).toBe("/billing/leaks");
  });

  it("offers only pages the person may open, and nothing for record lookups", () => {
    expect(intentHits("overdue invoices", only("dispatch.view"))).toEqual([]);
    expect(intentHits("ORD-1042", all)).toEqual([]);
    expect(intentHits("", all)).toEqual([]);
    expect(intentHits("profit", all).length).toBeLessThanOrEqual(3);
  });
});
