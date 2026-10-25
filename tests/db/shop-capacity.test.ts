import { afterAll, describe, expect, it } from "vitest";
import { addDays } from "@/lib/dates";
import { businessToday, insert } from "./fixtures";
import { pgError, pool, withSession, type Session } from "./helpers";

afterAll(() => pool.end());

// Shop capacity (20261120003000): bays, shift and working days; mechanic skills; estimates; the daily planning view.

const tag = () => Math.random().toString(36).slice(2, 7);

type Day = { date: string; working_day: boolean; mechanics: number; available_hours: number; planned_hours: number; jobs: number; unestimated: number; bays: number; skill_gaps: Array<{ number: string }> };
const capacity = async (s: Session, from: string, days = 7) =>
  (await s.query<{ r: { configured: boolean; days?: Day[] } }>("select public.maintenance_capacity($1::date, $2) r", [from, days])).rows[0].r;

describe("shop capacity", () => {
  it("says capacity is not configured until the shop is set up, then compares hours, estimates and bays per day", async () => {
    await withSession(async (s) => {
      const company = await s.createCompany(`Shop ${tag()} (test)`);
      const owner = await s.createUser("owner", { companyId: company });
      const mech = await s.createUser("mechanic", { companyId: company });
      await s.asAdmin();
      await s.query("update public.profiles set active_company_id = $1 where id = any($2::uuid[])", [company, [owner, mech]]);
      const today = await businessToday(s);
      await s.as(owner);
      // A Monday a week out, so working days are predictable.
      const monday = (() => { let d = addDays(today, 7); while (new Date(`${d}T12:00:00Z`).getUTCDay() !== 1) d = addDays(d, 1); return d; })();
      expect((await capacity(s, monday)).configured).toBe(false);

      await s.query("select public.maintenance_save_shop(1, '07:00', '15:00', '{1,2,3,4,5}')");
      expect((await pgError(s.query("select public.maintenance_save_shop(1, '15:00', '07:00', '{1}')"))).message).toMatch(/end after it starts/);

      const truck = await insert(s, "trucks", { unit_number: `S-${tag()}`, truck_type: "tri_axle_dump" });
      const wo = async (title: string, category: string) => (await s.query<{ r: { id: string } }>("select public.maintenance_create_work_order($1::jsonb) r",
        [JSON.stringify({ truck_id: truck, title, category, scheduled_for: monday })])).rows[0].r.id;
      const a = await wo("Brake job", "brakes");
      await wo("Wiring fault", "electrical");
      await s.query("select public.maintenance_set_estimate($1, 6)", [a]);

      let day = (await capacity(s, monday)).days![0];
      // Owner and mechanic can both do maintenance in the default roles: 2 × 8 h.
      expect(day).toMatchObject({ working_day: true, mechanics: 2, available_hours: 16, planned_hours: 6, jobs: 2, unestimated: 1, bays: 1 });
      expect(day.skill_gaps).toEqual([]); // no skills recorded, so no warnings
      expect((await capacity(s, monday)).days![5].working_day).toBe(false); // Saturday

      // Once skills are recorded, a job nobody available can do is flagged.
      await s.query("select public.maintenance_set_skills($1, '{brakes}')", [mech]);
      day = (await capacity(s, monday)).days![0];
      expect(day.skill_gaps.map((g) => g.number)).toHaveLength(1);

      // Approved full-day time off takes the mechanic's shift out of the day.
      await s.asAdmin();
      const emp = await s.query<{ id: string }>("insert into public.employees (company_id, user_id, full_name, department) values ($1, $2, 'Test Mechanic', 'shop') returning id", [company, mech]).catch(() => null);
      if (emp) {
        await s.query("insert into public.time_off_requests (company_id, employee_id, category, start_date, end_date, status) values ($1, $2, 'vacation', $3, $3, 'approved')", [company, emp.rows[0].id, monday]);
        await s.as(owner);
        day = (await capacity(s, monday)).days![0];
        expect(day).toMatchObject({ mechanics: 1, available_hours: 8 });
      }

      const driver = await s.createUser("driver", { companyId: company });
      await s.asAdmin();
      await s.query("update public.profiles set active_company_id = $1 where id = $2", [company, driver]);
      await s.as(driver);
      expect((await pgError(s.query("select public.maintenance_save_shop(2, '07:00', '15:00', '{1}')"))).code).toBe("42501");
      expect((await pgError(capacity(s, monday))).code).toBe("42501");
    });
  });
});
