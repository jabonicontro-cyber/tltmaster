import { describe, expect, it } from "vitest";
import { DUMP_BODY_ITEMS, INSPECTION_ITEMS, itemLabel, itemsFor } from "@/lib/inspections/items";

describe("inspection items per truck (UX9)", () => {
  it("adds the dump body on dump trucks only, never as safety items", () => {
    expect(itemsFor(false)).toHaveLength(INSPECTION_ITEMS.length);
    expect(itemsFor(true).map((i) => i.key)).toEqual([...INSPECTION_ITEMS.map((i) => i.key), "air_lines", "hoist_body", "pto", "tarp", "tailgate"]);
    expect(DUMP_BODY_ITEMS.every((i) => !i.safety)).toBe(true);
    expect(itemLabel("tailgate")).toBe("Tailgate and latches");
  });
});
