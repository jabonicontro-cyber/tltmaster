import { afterAll, describe, expect, it } from "vitest";
import { pgError, pool, withSession } from "./helpers";

afterAll(() => pool.end());

// 1×1 images (real magic numbers) as base64.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 0xff, 0xd9]).toString("base64");

describe("profile self-service", () => {
  it("lets people change only their own display name and phone", async () => {
    await withSession(async (s) => {
      const me = await s.createUser("driver");
      const other = await s.createUser("office");
      await s.as(me);
      await s.query("select public.update_my_profile($1, $2)", ["  Pat   the Driver ", "+1 (555) 010-2000"]);
      const mine = (await s.query("select public.my_profile() as p")).rows[0].p;
      expect(mine).toMatchObject({ user_id: me, display_name: "Pat the Driver", phone: "+1 (555) 010-2000", full_name: "Test driver" });

      // Bad input is refused with a reason, and nothing changes.
      expect((await pgError(s.query("select public.update_my_profile($1, '')", ["x".repeat(61)]))).code).toBe("22023");
      expect((await pgError(s.query("select public.update_my_profile('', $1)", ["call me maybe"]))).code).toBe("22023");
      expect((await pgError(s.query("select public.update_my_profile($1, '')", ["<b>Pat</b>"]))).code).toBe("22023");

      // The function has no way to reach anyone else's row.
      await s.asAdmin();
      const theirs = await s.query("select display_name, phone from public.profiles where id = $1", [other]);
      expect(theirs.rows[0]).toEqual({ display_name: "", phone: "" });
    });
  });

  it("keeps roles, memberships and the administrator's full name out of self-service", async () => {
    await withSession(async (s) => {
      const me = await s.createUser("driver");
      await s.as(me);
      await s.query("select public.update_my_profile('Boss', '')");
      await s.asAdmin();
      const row = await s.query("select m.role, m.active, p.full_name from public.company_memberships m join public.profiles p on p.id = m.user_id where m.user_id = $1", [me]);
      expect(row.rows[0]).toEqual({ role: "driver", active: true, full_name: "Test driver" });
    });
  });

  it("stores a checked photo, shows it inside the company only, and removes it on request", async () => {
    await withSession(async (s) => {
      const me = await s.createUser("driver");
      const colleague = await s.createUser("dispatcher");
      const otherCompany = await s.createCompany("Elsewhere Hauling (test)");
      const stranger = await s.createUser("owner", { companyId: otherCompany });
      await s.asAdmin();
      await s.query("update public.profiles set active_company_id = $2 where id = $1", [stranger, otherCompany]);

      await s.as(me);
      const at = (await s.query("select public.set_my_photo('image/png', $1) as at", [PNG])).rows[0].at;
      expect(at).toBeTruthy();
      expect((await s.query("select public.my_profile() as p")).rows[0].p.photo_updated_at).toBeTruthy();
      expect((await s.query("select mime_type from public.profile_photo($1)", [me])).rows).toEqual([{ mime_type: "image/png" }]);

      await s.as(colleague);
      expect((await s.query("select data_base64 from public.profile_photo($1)", [me])).rows[0].data_base64).toBe(PNG);

      await s.as(stranger);
      expect((await s.query("select * from public.profile_photo($1)", [me])).rowCount).toBe(0);

      await s.as(null);
      expect((await pgError(s.query("select * from public.profile_photo($1)", [me]))).code).toBe("42501");

      await s.as(me);
      await s.query("select public.set_my_photo('image/jpeg', $1)", [JPEG]); // replace
      expect((await s.query("select mime_type from public.profile_photo($1)", [me])).rows[0].mime_type).toBe("image/jpeg");
      await s.query("select public.set_my_photo(null, null)"); // remove
      expect((await s.query("select * from public.profile_photo($1)", [me])).rowCount).toBe(0);
      expect((await s.query("select public.my_profile() as p")).rows[0].p.photo_updated_at).toBeNull();
    });
  });

  it("refuses files that are not what they claim, too large, or unreadable", async () => {
    await withSession(async (s) => {
      const me = await s.createUser("office");
      await s.as(me);
      expect((await pgError(s.query("select public.set_my_photo('image/jpeg', $1)", [PNG]))).message).toMatch(/not a valid/);
      expect((await pgError(s.query("select public.set_my_photo('image/svg+xml', $1)", [PNG]))).code).toBe("22023");
      expect((await pgError(s.query("select public.set_my_photo('image/png', $1)", [Buffer.from("<html>").toString("base64")]))).code).toBe("22023");
      expect((await pgError(s.query("select public.set_my_photo('image/png', $1)", ["%%%not base64%%%"]))).code).toBe("22023");
      const big = Buffer.concat([Buffer.from(PNG, "base64"), Buffer.alloc(205_000)]).toString("base64");
      expect((await pgError(s.query("select public.set_my_photo('image/png', $1)", [big]))).message).toMatch(/too large/);
      // The photo table itself is never readable by app users.
      expect((await pgError(s.query("select * from private.profile_photos"))).code).toBe("42501");
    });
  });
});
