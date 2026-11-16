import { describe, expect, it } from "vitest";
import { DATE_REQUIRED_MESSAGE, OPERATIONAL_DATE_MESSAGE } from "@/lib/dates";
import { adaptWording } from "@/lib/industry";
import { intentHits } from "@/lib/search-intents";
import { referencePattern, searchableGroups } from "@/lib/search";
import { timeOffSchema } from "@/lib/time-off";
import { timeOffWaitingFor, timeOffWaitingRow } from "@/lib/time-off-waiting";
import type { Permission } from "@/lib/permissions";

// First-day walkthrough fixes, batch 1 (money, billing, office desk, owner home; 2026-11-16).

describe("O1: time off waiting for this person", () => {
  const rows = [
    { id: "a", employee_id: "e-me", start_date: "2026-11-20", approval_step: null },
    { id: "b", employee_id: "e-sam", start_date: "2026-12-01", approval_step: null },
    { id: "c", employee_id: "e-ann", start_date: "2026-11-25", approval_step: 2 },
  ];

  it("never counts the person's own request, soonest first", () => {
    expect(timeOffWaitingFor(rows, { employeeId: "e-me", role: "owner" }, null).map((r) => r.id)).toEqual(["c", "b"]);
    // Without a People record, nothing is "own".
    expect(timeOffWaitingFor(rows, { employeeId: null, role: "owner" }, []).map((r) => r.id)).toEqual(["a", "c", "b"]);
  });

  it("with an approval chain, only the role of the step the request waits for decides it", () => {
    const chain = [{ step_no: 1, role: "office" }, { step_no: 2, role: "owner" }];
    expect(timeOffWaitingFor(rows, { employeeId: "e-me", role: "owner" }, chain).map((r) => r.id)).toEqual(["c"]);
    expect(timeOffWaitingFor(rows, { employeeId: "e-me", role: "office" }, chain).map((r) => r.id)).toEqual(["b"]);
  });

  it("is a queue row only when something waits", () => {
    expect(timeOffWaitingRow([])).toBeNull();
    const row = timeOffWaitingRow([{ name: "Sam Carter", when: "Nov 20, 2026" }, { name: "Ann Lee", when: "Dec 1, 2026" }]);
    expect(row).toMatchObject({ kind: "time_off", label: "Time off waiting for you (2)", count: 2, urgent: 0, href: "/time-off?status=pending" });
    expect(row?.example).toBe("Sam Carter, Nov 20, 2026");
  });
});

describe("O2: an empty date says what to do", () => {
  const base = { category: "vacation", day_kind: "full", end_date: "", reason: "" };
  const message = (start: string) => {
    const r = timeOffSchema.safeParse({ ...base, start_date: start });
    return r.success ? null : r.error.issues.find((i) => i.path[0] === "start_date")?.message;
  };
  it("empty: choose a date; a broken year: the 4-digit-year message", () => {
    expect(message("")).toBe(DATE_REQUIRED_MESSAGE);
    expect(message("   ")).toBe(DATE_REQUIRED_MESSAGE);
    expect(message("0026-11-20")).toBe(OPERATIONAL_DATE_MESSAGE);
    expect(message("2026-11-20") ?? null).toBeNull();
  });
});

describe("M8: invoices in search, and fuel/IFTA", () => {
  it("invoices are searched only with billing.view", () => {
    expect(searchableGroups(["orders.view"] as Permission[]).map((g) => g.key)).not.toContain("invoices");
    expect(searchableGroups(["billing.view"] as Permission[]).map((g) => g.key)).toEqual(["invoices"]);
  });

  it("an invoice number typed without its dash still matches", () => {
    expect(referencePattern("INV1001")).toBe("%INV%1001%");
    expect(referencePattern("inv-1001")).toBe("%INV%1001%");
    expect(referencePattern("1001")).toBe("%1001%");
    expect(referencePattern("Riverbend")).toBeNull();
    // Only letters, digits and % reach the PostgREST filter.
    expect(referencePattern("INV-1001'),id.eq.(x")).toMatch(/^[A-Z0-9%]+$/);
  });

  it("fuel and IFTA open Fuel and IFTA for people who see the fleet", () => {
    const fleet = (p: Permission) => p === "fleet.view";
    for (const q of ["fuel", "IFTA", "ifta report", "diesel"]) expect(intentHits(q, fleet)[0]?.href, q).toBe("/fleet/fuel");
    expect(intentHits("fuel", () => false)).toEqual([]);
  });
});

describe("M10: payments by ticket in a freight carrier's words", () => {
  it("the paper-number hint and labels read BOL for freight, unchanged for aggregate", () => {
    const hint = "Type them, or paste rows copied from the customer's spreadsheet or email (with amounts, each ticket gets its amount). The paper or scale ticket number works too.";
    expect(adaptWording(hint, "freight")).toContain("The BOL number works too.");
    expect(adaptWording(hint, "freight")).not.toMatch(/ticket/i);
    expect(adaptWording(hint, "aggregate")).toBe(hint);
    expect(adaptWording("Scale ticket", "freight")).toBe("BOL");
    expect(adaptWording("Ticket numbers from the check stub or remittance", "freight")).toBe("BOL number from the check stub or remittance");
  });
});
