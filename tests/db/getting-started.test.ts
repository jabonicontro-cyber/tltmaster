// Getting started (20261120014100): a person puts the checklist away for themselves in the current company only.
import { afterAll, describe, expect, it } from "vitest";
import { pgError, pool, TOP_LINE, withSession } from "./helpers";

afterAll(() => pool.end());

describe("getting started dismissal", () => {
  it("is remembered for the caller in the current company only, and a repeat changes nothing", async () => {
    await withSession(async (s) => {
      const office = await s.createUser("office");
      const dispatcher = await s.createUser("dispatcher");
      await s.as(office);
      expect((await s.query("select 1 from public.user_preferences where key = 'getting_started'")).rowCount).toBe(0);
      await s.query("select public.dismiss_getting_started()");
      const first = (await s.query<{ value: { dismissed_at: string } }>("select value from public.user_preferences where key = 'getting_started'")).rows;
      expect(first).toHaveLength(1);
      await s.query("select public.dismiss_getting_started()");
      const again = (await s.query<{ value: { dismissed_at: string } }>("select value from public.user_preferences where key = 'getting_started'")).rows;
      expect(again[0].value.dismissed_at).toBe(first[0].value.dismissed_at);

      // Another person in the same company still sees their own checklist, and cannot read the office person's row.
      await s.as(dispatcher);
      expect((await s.query("select 1 from public.user_preferences where key = 'getting_started'")).rowCount).toBe(0);

      // Another company: nothing of it, and the dismissal there is separate.
      await s.asAdmin();
      const rows = (await s.query<{ company_id: string; user_id: string }>("select company_id, user_id from public.user_preferences where key = 'getting_started' and user_id = $1", [office])).rows;
      expect(rows).toEqual([{ company_id: TOP_LINE, user_id: office }]);
      // People cannot write preferences directly (only through the functions).
      await s.as(office);
      expect((await pgError(s.query("insert into public.user_preferences (company_id, user_id, key, value) values ($1, $2, 'getting_started', '{}')", [TOP_LINE, dispatcher]))).code).toBe("42501");
      // Signed out: refused.
      await s.as(null);
      expect((await pgError(s.query("select public.dismiss_getting_started()"))).code).toBe("42501");
    });
  });
});
