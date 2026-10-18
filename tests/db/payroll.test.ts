// Driver payroll from delivery tickets (20261118000200): owner-only access, versioned rules with an explicit
// activation, nothing paid until calculation is turned on, one ledger entry per ticket and driver (no double pay),
// verified tickets only, locked approved periods, corrections settled by adjustments, idempotent exports, audit.
// Fictional data; every test runs in a rolled-back transaction.
import { createHash, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { addDays } from "@/lib/dates";
import { assign, businessToday, fleet, planLoad, scheduledOrder } from "./fixtures";
import { pgError, pool, withSession, type Session } from "./helpers";

afterAll(() => pool.end());

type Row = Record<string, unknown>;

/** An accepted ticket for driver A yesterday (21.47 t), entered and verified by the office. */
async function world(s: Session) {
  const today = await businessToday(s);
  const yesterday = addDays(today, -1);
  const office = await s.createUser("office");
  const owner = await s.createUser("owner");
  const f = await fleet(s, office, yesterday);
  const order = await scheduledOrder(s, office, addDays(today, -2), today, addDays(today, -2));
  const load = await planLoad(s, order.id, yesterday, "07:00", "09:00", { planned_quantity: "22", unit_code: "ton" });
  await assign(s, load.load_id, f.t1, null, f.d1);
  await s.as(office);
  const payload = { load_id: load.load_id, order_line_id: order.materialLine, delivered_date: yesterday, delivered_time: "08:30", quantity: "21.47", unit_code: "ton", external_reference: `SC-${randomUUID().slice(0, 8)}`, notes: "" };
  const t = (await s.query<{ r: { ticket_id: string; ticket_number: string } }>("select public.submit_delivery_ticket($1::jsonb) as r", [JSON.stringify(payload)])).rows[0].r;
  await s.query("select public.review_delivery_ticket($1, 'accept', 'Matches scale ticket')", [t.ticket_id]);
  return { today, yesterday, office, owner, f, order, load, payload, ticket: t };
}

const call = async <T = unknown>(s: Session, sql: string, params: unknown[] = []) => (await s.query<{ r: T }>(`select ${sql} as r`, params)).rows[0]?.r;
const entry = (w: Awaited<ReturnType<typeof world>>, rule: string | null, amount: number | null, status = "calculated"): Row =>
  ({ ticket_id: w.ticket.ticket_id, driver_id: w.f.d1, rule_version_id: rule, status, amount_cents: amount, inputs: { tons: "21.47", rate: "4.25" }, breakdown: "(tons (21.47) * rate (4.25)) = 91.2475 → 91.25", exception: status === "exception" ? "missing_input: rate" : "" });

describe("driver payroll", () => {
  it("is for payroll.manage only (owner by default): office, dispatch and drivers see and change nothing", async () => {
    await withSession(async (s) => {
      const w = await world(s);
      for (const role of ["office", "dispatcher", "driver"] as const) {
        const u = role === "office" ? w.office : await s.createUser(role);
        await s.as(u);
        expect((await pgError(s.query("select public.payroll_period_create($1, $2)", [w.yesterday, w.today]))).code, role).toBe("42501");
        expect((await pgError(s.query("select public.payroll_rule_draft('{}'::jsonb)"))).code, role).toBe("42501");
        expect((await s.query("select 1 from public.pay_rule_versions union all select 1 from public.payroll_entries")).rowCount, role).toBe(0);
        for (const t of ["payroll_settings", "pay_rules", "payroll_periods", "payroll_entries", "payroll_adjustments", "payroll_exports"]) {
          expect((await pgError(s.query(`insert into public.${t} (company_id) values ('00000000-0000-4000-8000-000000000001')`))).code, `${role} ${t}`).toBe("42501");
        }
      }
    });
  });

  it("pays nothing until a confirmed rule is active and calculation is on; a verified ticket is paid once, retries add nothing", async () => {
    await withSession(async (s) => {
      const w = await world(s);
      await s.as(w.owner);
      const period = await call<string>(s, "public.payroll_period_create($1, $2)", [w.yesterday, w.today]);
      const work = await call<{ payable: Row[]; not_payable: Row[] }>(s, "public.payroll_period_work($1)", [period]);
      // (The shared test company may hold other accepted tickets from that day; this test follows its own.)
      const mine = (rows: Row[]) => rows.filter((t) => t.ticket_id === w.ticket.ticket_id);
      expect(mine(work.payable)).toEqual([expect.objectContaining({ quantity: 21.47, unit_code: "ton", driver_id: w.f.d1, delivered_on: w.yesterday })]);

      const draft = await call<string>(s, "public.payroll_rule_draft($1::jsonb)", [JSON.stringify({ name: `Per ton ${randomUUID().slice(0, 6)}`, formula: "tons * rate", rate: "4.25", unit_code: "ton", effective_from: addDays(w.today, -30), evidence_note: "Test rule (fictional)" })]);
      expect((await pgError(s.query("select public.payroll_settings_save($1::jsonb)", [JSON.stringify({ enabled: true })]))).message).toMatch(/Activate at least one pay rule/);
      // A draft never pays, and nothing is calculated while calculation is off.
      expect((await pgError(s.query("select public.payroll_record_entries($1, $2::jsonb)", [period, JSON.stringify([entry(w, draft, 9125)])]))).message).toMatch(/not turned on/);
      await s.query("select public.payroll_rule_activate($1, 'Confirmed with the owner (test)')", [draft]);
      await s.query("select public.payroll_settings_save($1::jsonb)", [JSON.stringify({ enabled: true, period_length: "weekly" })]);
      expect(await call(s, "public.payroll_record_entries($1, $2::jsonb)", [period, JSON.stringify([entry(w, draft, 9125)])])).toEqual({ added: 1, already_recorded: 0 });
      expect(await call(s, "public.payroll_record_entries($1, $2::jsonb)", [period, JSON.stringify([entry(w, draft, 9125)])])).toEqual({ added: 0, already_recorded: 1 });
      expect(mine((await call<{ payable: Row[] }>(s, "public.payroll_period_work($1)", [period])).payable)).toEqual([]); // paid: no longer payable
      await s.asAdmin();
      const v = (await s.query("select status, approved_by from public.pay_rule_versions where id = $1", [draft])).rows[0];
      expect(v).toEqual({ status: "active", approved_by: w.owner });
      const audit = (await s.query("select action from public.audit_events where action like 'payroll.%' and entity_id in ($1, $2) order by occurred_at", [draft, period])).rows.map((r) => r.action);
      expect(audit).toEqual(expect.arrayContaining(["payroll.rule_drafted", "payroll.rule_activated", "payroll.period_created", "payroll.entries_recorded"]));
    });
  });

  it("refuses unverified tickets, another driver's ticket, a ticket outside the period, overlapping rules and overlapping periods", async () => {
    await withSession(async (s) => {
      const w = await world(s);
      await s.as(w.owner);
      const rule = await call<string>(s, "public.payroll_rule_draft($1::jsonb)", [JSON.stringify({ name: `Per ton ${randomUUID().slice(0, 6)}`, formula: "tons * rate", rate: "4", unit_code: "ton", effective_from: addDays(w.today, -30) })]);
      await s.query("select public.payroll_rule_activate($1, '')", [rule]);
      const twin = await call<string>(s, "public.payroll_rule_draft($1::jsonb)", [JSON.stringify({ name: `Twin ${randomUUID().slice(0, 6)}`, formula: "tons * rate", rate: "5", unit_code: "ton", effective_from: addDays(w.today, -10) })]);
      expect((await pgError(s.query("select public.payroll_rule_activate($1, '')", [twin]))).message).toMatch(/Another active rule covers the same tickets/);
      await s.query("select public.payroll_settings_save($1::jsonb)", [JSON.stringify({ enabled: true })]);
      const period = await call<string>(s, "public.payroll_period_create($1, $2)", [w.yesterday, w.today]);
      expect((await pgError(s.query("select public.payroll_period_create($1, $2)", [w.today, addDays(w.today, 3)]))).message).toMatch(/overlaps/);
      expect((await pgError(s.query("select public.payroll_record_entries($1, $2::jsonb)", [period, JSON.stringify([{ ...entry(w, rule, 8588), driver_id: w.f.d2 }])]))).message).toMatch(/not this driver/);
      const later = await call<string>(s, "public.payroll_period_create($1, $2)", [addDays(w.today, 7), addDays(w.today, 13)]);
      expect((await pgError(s.query("select public.payroll_record_entries($1, $2::jsonb)", [later, JSON.stringify([entry(w, rule, 8588)])]))).message).toMatch(/outside this period/);
      // A ticket waiting for review is listed as not payable and refused.
      await s.as(w.office);
      const pending = (await s.query<{ r: { ticket_id: string } }>("select public.submit_delivery_ticket($1::jsonb) as r", [JSON.stringify({ ...w.payload, delivered_time: "10:00", external_reference: `SC-${randomUUID().slice(0, 8)}`, confirm_duplicate: true })])).rows[0].r;
      await s.as(w.owner);
      const work = await call<{ not_payable: Row[] }>(s, "public.payroll_period_work($1)", [period]);
      expect(work.not_payable).toEqual(expect.arrayContaining([expect.objectContaining({ ticket_id: pending.ticket_id, reason: "not_verified" })]));
      expect((await pgError(s.query("select public.payroll_record_entries($1, $2::jsonb)", [period, JSON.stringify([{ ...entry(w, rule, 100), ticket_id: pending.ticket_id }])]))).message).toMatch(/not verified/);
    });
  });

  it("approval waits for exceptions, locks the period with its totals, and later corrections become adjustments", async () => {
    await withSession(async (s) => {
      const w = await world(s);
      await s.as(w.owner);
      const rule = await call<string>(s, "public.payroll_rule_draft($1::jsonb)", [JSON.stringify({ name: `Per ton ${randomUUID().slice(0, 6)}`, formula: "tons * rate", rate: "4.25", unit_code: "ton", effective_from: addDays(w.today, -30) })]);
      await s.query("select public.payroll_rule_activate($1, '')", [rule]);
      await s.query("select public.payroll_settings_save($1::jsonb)", [JSON.stringify({ enabled: true })]);
      const period = await call<string>(s, "public.payroll_period_create($1, $2)", [w.yesterday, w.today]);
      await s.query("select public.payroll_record_entries($1, $2::jsonb)", [period, JSON.stringify([entry(w, null, null, "exception")])]);
      expect((await pgError(s.query("select public.payroll_period_approve($1)", [period]))).message).toMatch(/still need review/);
      await s.asAdmin();
      const exc = (await s.query("select id from public.payroll_entries where period_id = $1", [period])).rows[0].id as string;
      await s.as(w.owner);
      // Resolve: reverse the exception (kept in history), then record the calculated earning.
      await s.query("select public.payroll_entry_set($1, 'reversed', 'Rate confirmed; recalculated')", [exc]);
      await s.query("select public.payroll_record_entries($1, $2::jsonb)", [period, JSON.stringify([entry(w, rule, 9125)])]);
      await s.query("select public.payroll_adjust($1, $2, 1500, 'Approved fuel stop reimbursement (test)', null)", [period, w.f.d1]);
      const totals = await call<{ total_cents: number; drivers: Row[] }>(s, "public.payroll_period_approve($1)", [period]);
      expect(totals.total_cents).toBe(10625);
      expect(totals.drivers).toEqual([{ driver_id: w.f.d1, tickets: 1, earnings_cents: 9125, adjustments_cents: 1500, total_cents: 10625 }]);
      expect((await pgError(s.query("select public.payroll_adjust($1, $2, 100, 'late change', null)", [period, w.f.d1]))).message).toMatch(/locked/);
      await s.asAdmin();
      const paid = (await s.query("select id from public.payroll_entries where period_id = $1 and status = 'calculated'", [period])).rows[0].id as string;

      // The ticket is corrected after approval: the approved period stays as it was; the next period lists it to settle.
      await s.as(w.office);
      await s.query("select public.correct_delivery_ticket($1, $2::jsonb, 'Scale ticket said 20.47 t')", [w.ticket.ticket_id, JSON.stringify({ ...w.payload, quantity: "20.47" })]);
      await s.as(w.owner);
      const next = await call<string>(s, "public.payroll_period_create($1, $2)", [addDays(w.today, 1), addDays(w.today, 7)]);
      const work = await call<{ corrections: Row[]; payable: Row[] }>(s, "public.payroll_period_work($1)", [next]);
      expect(work.corrections).toEqual([expect.objectContaining({ entry_id: paid, ticket_status: "superseded", amount_cents: 9125 })]);
      await s.query("select public.payroll_adjust($1, $2, -425, 'Ticket corrected from 21.47 t to 20.47 t after approval', $3)", [next, w.f.d1, paid]);
      expect((await call<{ corrections: Row[] }>(s, "public.payroll_period_work($1)", [next])).corrections).toEqual([]);
      await s.asAdmin();
      expect((await s.query("select totals ->> 'total_cents' as t from public.payroll_periods where id = $1", [period])).rows[0].t).toBe("10625");
    });
  });

  it("exports only approved totals, once per content, and records what the destination did", async () => {
    await withSession(async (s) => {
      const w = await world(s);
      await s.as(w.owner);
      const rule = await call<string>(s, "public.payroll_rule_draft($1::jsonb)", [JSON.stringify({ name: `Per ton ${randomUUID().slice(0, 6)}`, formula: "tons * rate", rate: "4.25", unit_code: "ton", effective_from: addDays(w.today, -30) })]);
      await s.query("select public.payroll_rule_activate($1, '')", [rule]);
      await s.query("select public.payroll_settings_save($1::jsonb)", [JSON.stringify({ enabled: true })]);
      const period = await call<string>(s, "public.payroll_period_create($1, $2)", [w.yesterday, w.today]);
      const hash = createHash("sha256").update("driver,amount\nDriver A,91.25\n").digest("hex");
      expect((await pgError(s.query("select public.payroll_export_record($1, 'summary_csv', $2, 1, 9125)", [period, hash]))).message).toMatch(/Approve the period/);
      await s.query("select public.payroll_record_entries($1, $2::jsonb)", [period, JSON.stringify([entry(w, rule, 9125)])]);
      await s.query("select public.payroll_period_approve($1)", [period]);
      expect((await pgError(s.query("select public.payroll_export_record($1, 'summary_csv', $2, 1, 9999)", [period, hash]))).message).toMatch(/does not match/);
      const first = await call<string>(s, "public.payroll_export_record($1, 'summary_csv', $2, 1, 9125)", [period, hash]);
      expect(await call<string>(s, "public.payroll_export_record($1, 'summary_csv', $2, 1, 9125)", [period, hash])).toBe(first);
      await s.query("select public.payroll_export_outcome($1, 'accepted', 'PR-1001', 'Imported by the bookkeeper (test)')", [first]);
      await s.asAdmin();
      expect((await s.query("select status from public.payroll_periods where id = $1", [period])).rows[0].status).toBe("reconciled");
    });
  });

  it("keeps each company's payroll to itself", async () => {
    await withSession(async (s) => {
      const w = await world(s);
      await s.as(w.owner);
      const rule = await call<string>(s, "public.payroll_rule_draft($1::jsonb)", [JSON.stringify({ name: `Per ton ${randomUUID().slice(0, 6)}`, formula: "tons * rate", rate: "4", unit_code: "ton", effective_from: addDays(w.today, -30) })]);
      const other = await s.createCompany("Other Hauling (test)");
      const otherOwner = await s.createUser("owner", { companyId: other });
      await s.as(otherOwner);
      expect((await s.query("select 1 from public.pay_rule_versions where id = $1", [rule])).rowCount).toBe(0);
      expect((await pgError(s.query("select public.payroll_rule_activate($1, '')", [rule]))).code).toBe("P0002");
      expect((await pgError(s.query("select public.payroll_rule_draft($1::jsonb)", [JSON.stringify({ name: "Cross (test)", formula: "tons * rate", rate: "4", effective_from: w.today, scope: { driver_id: w.f.d1 } })]))).message).toMatch(/not in this company/);
    });
  });
});
