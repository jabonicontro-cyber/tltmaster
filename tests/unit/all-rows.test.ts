import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const { allRows, PAGE_ROWS } = await import("@/server/data/all-rows");

// The database API returns at most 1000 rows per request whatever .limit() asks for; allRows reads every page.
function source(total: number, error?: { code: string; message: string }) {
  const ranges: Array<[number, number]> = [];
  const query = () => ({
    range: (from: number, to: number) => {
      ranges.push([from, to]);
      if (error) return Promise.resolve({ data: null, error });
      return Promise.resolve({ data: Array.from({ length: Math.max(0, Math.min(to, total - 1) - from + 1) }, (_, k) => from + k), error: null });
    },
  });
  return { query, ranges };
}

describe("allRows", () => {
  it("reads every page until a short one", async () => {
    const s = source(2 * PAGE_ROWS + 5);
    const r = await allRows<number>(s.query);
    expect(r.error).toBeNull();
    expect(r.data).toHaveLength(2 * PAGE_ROWS + 5);
    expect(new Set(r.data).size).toBe(2 * PAGE_ROWS + 5);
    expect(s.ranges).toEqual([[0, 999], [1000, 1999], [2000, 2999]]);
  });

  it("keeps a row once when a record saved between two pages shifts it onto the next page", async () => {
    let call = 0;
    const query = () => ({
      range: () => {
        call += 1;
        // Page 1 ends with r999; a new record then shifts everything down, so page 2 starts with r999 again.
        const start = call === 1 ? 0 : 999;
        const n = call === 1 ? PAGE_ROWS : 2;
        return Promise.resolve({ data: Array.from({ length: n }, (_, k) => ({ id: `r${start + k}` })), error: null });
      },
    });
    const r = await allRows<{ id: string }>(query);
    expect(r.data!.map((x) => x.id).filter((id) => id === "r999")).toHaveLength(1);
    expect(r.data).toHaveLength(PAGE_ROWS + 1);
  });

  it("passes an error through and returns no rows", async () => {
    const r = await allRows(source(10, { code: "PGRST205", message: "missing" }).query);
    expect(r).toEqual({ data: null, error: { code: "PGRST205", message: "missing" } });
  });

  it("fails rather than return part of the list when there are more pages than allowed", async () => {
    const r = await allRows(source(5 * PAGE_ROWS).query, 3);
    expect(r.data).toBeNull();
    expect(r.error?.code).toBe("too_many_rows");
  });
});
