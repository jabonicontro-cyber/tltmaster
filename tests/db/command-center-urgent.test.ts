// Command Center urgent breakdown (20261119000200): per-kind priority-1 counts that add up exactly to the summary's
// urgent total, for every role (each sees only its own kinds), so the status strip never counts an item twice.
import { afterAll, describe, expect, it } from "vitest";
import { pgError, pool, withSession } from "./helpers";

afterAll(() => pool.end());

describe("command center urgent breakdown", () => {
  it("adds up to the summary's urgent count for each role, and is refused without the Command Center", async () => {
    await withSession(async (s) => {
      for (const role of ["owner", "office", "dispatcher", "mechanic"] as const) {
        const u = await s.createUser(role);
        await s.as(u);
        const summary = (await s.query<{ r: { exceptions: { urgent: number } } }>("select public.command_center_summary() as r")).rows[0].r;
        const byKind = (await s.query<{ r: Record<string, number> }>("select public.command_center_urgent_by_kind() as r")).rows[0].r;
        expect(Object.values(byKind).reduce((n, v) => n + v, 0), role).toBe(summary.exceptions.urgent);
      }
      const driver = await s.createUser("driver");
      await s.as(driver);
      expect((await pgError(s.query("select public.command_center_urgent_by_kind()"))).code).toBe("42501");
    });
  });
});
