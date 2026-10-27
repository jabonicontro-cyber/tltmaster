import { describe, expect, it } from "vitest";
import { share } from "@/lib/drivers/scorecard";

// Driver scorecard (B96): a share is shown only with three or more behind it.
describe("scorecard shares", () => {
  it("rounds to whole percent and hides small samples", () => {
    expect(share(2, 3)).toBe(67);
    expect(share(1, 2)).toBeNull();
    expect(share(0, 0)).toBeNull();
    expect(share(5, 5)).toBe(100);
  });
});
