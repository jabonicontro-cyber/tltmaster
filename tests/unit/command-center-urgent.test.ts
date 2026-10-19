import { describe, expect, it } from "vitest";
import { urgentSummary } from "@/lib/command-center/urgent";

describe("Command Center urgent indicator", () => {
  it("shows nothing when nothing is urgent", () => {
    expect(urgentSummary({})).toBeNull();
    expect(urgentSummary(null)).toBeNull();
    expect(urgentSummary({ urgent_order: 0 })).toBeNull();
  });

  it("names a single urgent order once, not as '1 urgent' plus '1 urgent order'", () => {
    expect(urgentSummary({ urgent_order: 1 })).toEqual({ total: 1, lead: "1 urgent order", kind: "urgent_order", parts: [] });
    expect(urgentSummary({ urgent_order: 2 })?.lead).toBe("2 urgent orders");
  });

  it("other single kinds say what they are", () => {
    expect(urgentSummary({ unassigned_load: 1 })?.lead).toBe("1 urgent: 1 load today without a truck");
    expect(urgentSummary({ unassigned_load: 3 })?.lead).toBe("3 urgent: 3 loads today without a truck");
  });

  it("mixed kinds: one total whose parts add up to it, in a fixed order, each item counted once", () => {
    const s = urgentSummary({ unassigned_load: 2, urgent_order: 1, assignment_problem: 1 })!;
    expect(s.lead).toBe("4 urgent");
    expect(s.kind).toBeNull();
    expect(s.parts.map((p) => p.text)).toEqual(["1 order", "2 loads today without a truck", "1 assignment the rules now refuse"]);
    expect(s.parts.reduce((n, p) => n + p.count, 0)).toBe(s.total);
  });

  it("an unknown kind is still counted (never dropped from the total)", () => {
    const s = urgentSummary({ urgent_order: 1, new_kind: 2 })!;
    expect(s.total).toBe(3);
    expect(s.parts.map((p) => p.text)).toEqual(["1 order", "2 items"]);
  });
});
