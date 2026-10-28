import { describe, expect, it } from "vitest";
import { matchScore, rankRows } from "@/lib/search/rank";

describe("best match first", () => {
  const rows = [
    { name: "Fieldhouse Hardwood Courts", city: "Lafayette" },
    { name: "Ironweed Implement", city: "Delphi" },
    { name: "Bluestem Grain Cooperative", city: "Rensselaer" },
    { name: "Wildrye Seed & Feed", city: "Fowler" },
  ];
  const fields = (r: (typeof rows)[number]) => ({ main: r.name, others: [r.city] });

  it("puts a name that starts with the search before a word match, and that before a match inside a word", () => {
    const list = [{ name: "Hayfeed Supply" }, { name: "Grain & Feed Co" }, { name: "Feed Barn" }];
    expect(rankRows(list, "feed", (r) => ({ main: r.name })).map((r) => r.name)).toEqual(["Feed Barn", "Grain & Feed Co", "Hayfeed Supply"]);
  });

  it("ranks a word start in the name above a match in another field", () => {
    expect(matchScore("seed", "Wildrye Seed & Feed")).toBeGreaterThan(matchScore("seed", "Other", ["Seedville"]));
  });

  it("leaves the order alone without a search, and keeps equal scores in order", () => {
    expect(rankRows(rows, "", fields)).toEqual(rows);
    expect(rankRows(rows, "zzz", fields)).toEqual(rows);
  });

  it("ignores case and accents", () => {
    expect(matchScore("CAFE", "Café Supply")).toBe(80);
  });
});
