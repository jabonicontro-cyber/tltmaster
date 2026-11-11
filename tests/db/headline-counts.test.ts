// One count per number (owner walkthrough WK1): each Command Center figure and the page it opens count the same
// records. The Command Center counts in the database (private.operational_exceptions_all); the pages read the billing
// views and field reports and apply the shared rules in src/lib (missingTicketKind, reportViewStatuses). This checks,
// for every company in the local database (seeded, demo and test companies alike), that both sides agree. Read only.
import { afterAll, describe, expect, it } from "vitest";
import { missingTicketKind } from "@/lib/billing/rules";
import { reportViewStatuses } from "@/lib/driver/rules";
import { pool, withSession } from "./helpers";

afterAll(() => pool.end());

describe("headline counts agree between the Command Center and the pages it opens", () => {
  it("missing tickets, loads without a truck, orders blocked from billing and driver reports not resolved", async () => {
    await withSession(async (s) => {
      await s.asAdmin();
      const companies = (await s.query<{ id: string }>("select id from public.companies where active order by created_at")).rows;
      expect(companies.length).toBeGreaterThan(0);
      let checked = 0;
      for (const { id } of companies) {
        const ex = (await s.query<{ kind: string; past: boolean }>(
          "select kind, coalesce((details ->> 'past')::boolean, false) as past from private.operational_exceptions_all($1)", [id])).rows;
        const loads = (await s.query<{ assignment_id: string | null; voided_numbers: string[] | null }>(
          "select assignment_id, voided_numbers from public.billing_load_status where company_id = $1 and documentation_state = 'missing'", [id])).rows;
        // Billing → Missing tickets (loads that ran) = the Command Center's "Missing delivery tickets".
        expect(loads.filter((l) => missingTicketKind(l) === "no_ticket").length, `missing tickets, company ${id}`)
          .toBe(ex.filter((e) => e.kind === "missing_ticket").length);
        // Billing's "ended without a truck" = the Command Center's past loads without a truck.
        expect(loads.filter((l) => missingTicketKind(l) === "no_truck").length, `ended without a truck, company ${id}`)
          .toBe(ex.filter((e) => e.kind === "unassigned_load" && e.past).length);
        // Billing → Exceptions, blocked only (BILLING_BLOCKED_HREF) = "Orders blocked from billing".
        const blocked = Number((await s.query<{ n: string }>(
          "select count(*) n from public.billing_order_status where company_id = $1 and readiness = 'blocked'", [id])).rows[0].n);
        expect(blocked, `blocked from billing, company ${id}`).toBe(ex.filter((e) => e.kind === "billing_blocked").length);
        // Driver Reports → Not resolved = "Driver reports not resolved".
        const reports = Number((await s.query<{ n: string }>(
          "select count(*) n from public.field_reports where company_id = $1 and status = any ($2::text[])", [id, reportViewStatuses("unresolved")])).rows[0].n);
        expect(reports, `driver reports, company ${id}`).toBe(ex.filter((e) => e.kind === "delay_report" || e.kind === "equipment_report").length);
        checked += loads.length + blocked + reports;
      }
      // Never compare only empty sets: the local database has seeded and demo records of each kind.
      expect(checked).toBeGreaterThan(0);
    });
  }, 120_000);
});
