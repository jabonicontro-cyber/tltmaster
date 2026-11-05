// Accessibility mode (owner 2026-11-05, migration 20261120007300): a person saves only their own settings, only the
// four known ones with valid values, and nobody else can read them.
import { afterAll, describe, expect, it } from "vitest";
import { pgError, pool, withSession } from "./helpers";

afterAll(() => pool.end());

describe("accessibility settings", () => {
  it("are saved per person, validated, and private", async () => {
    await withSession(async (s) => {
      const a = await s.createUser("driver");
      const b = await s.createUser("owner");
      await s.as(a);
      const saved = (await s.query<{ r: Record<string, unknown> }>("select public.set_my_accessibility($1::jsonb) r", [JSON.stringify({ textSize: 130, highContrast: true, unknown: "dropped" })])).rows[0].r;
      expect(saved).toEqual({ textSize: 130, highContrast: true, reduceMotion: false, readableFont: false });
      expect((await pgError(s.query("select public.set_my_accessibility($1::jsonb)", [JSON.stringify({ textSize: 200 })]))).message).toMatch(/100%, 115% or 130%/);
      expect((await pgError(s.query("select public.set_my_accessibility('[]'::jsonb)"))).message).toMatch(/could not be read/);
      // Saving again replaces the row.
      await s.query("select public.set_my_accessibility($1::jsonb)", [JSON.stringify({ readableFont: true })]);
      const mine = (await s.query<{ settings: Record<string, unknown> }>("select settings from public.user_accessibility")).rows;
      expect(mine).toEqual([{ settings: { textSize: 100, highContrast: false, reduceMotion: false, readableFont: true } }]);
      // Direct writes are refused; another person sees nothing.
      expect((await pgError(s.query("update public.user_accessibility set settings = '{}'"))).code).toBe("42501");
      await s.as(b);
      expect((await s.query("select * from public.user_accessibility")).rows).toEqual([]);
      await s.query("set local role anon");
      expect((await pgError(s.query("select public.set_my_accessibility('{}'::jsonb)"))).code).toBe("42501");
    });
  });
});
