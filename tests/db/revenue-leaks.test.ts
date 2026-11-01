// Revenue leakage finder (B110, migration 20261120005100): delivered work not handed off after N days, handed off for
// fewer units than delivered (amount from the order's rate), a voided invoice not replaced; billing.view to read,
// billing.manage to mark checked (hidden until the amount changes, shown again on reopen); other companies see nothing.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { addDays } from "@/lib/dates";
import { assign, businessToday, fleet, planLoad, scheduledOrder } from "./fixtures";
import { pgError, pool, withSession, type Session } from "./helpers";

afterAll(() => pool.end());

type Leak = { finding_key: string; kind: string; order_id: string; amount_cents: string | null; estimated: boolean; checked_reason: string | null };

/** A completed order whose one ticket delivered `delivered` tons of gravel (ordered 40 at $10/ton), ready to bill. */
async function delivered(s: Session, office: string, deliveredTons: number) {
  const today = await businessToday(s);
  const yesterday = addDays(today, -1);
  const f = await fleet(s, office, yesterday);
  const order = await scheduledOrder(s, office, addDays(today, -2), addDays(today, 2), addDays(today, -2));
  const load = await planLoad(s, order.id, yesterday, "07:00", "09:00", { planned_quantity: "40", unit_code: "ton" });
  await assign(s, load.load_id, f.t1, null, f.d1);
  await s.as(office);
  const t = (await s.query<{ r: { ticket_id: string } }>("select public.submit_delivery_ticket($1::jsonb) as r", [JSON.stringify({
    load_id: load.load_id, order_line_id: order.materialLine, delivered_date: yesterday, delivered_time: "08:00", quantity: String(deliveredTons),
    unit_code: "ton", external_reference: `SC-${randomUUID().slice(0, 8)}`,
  })])).rows[0].r;
  await s.query("select public.review_delivery_ticket($1, 'accept', '')", [t.ticket_id]);
  await s.query("select public.set_order_status($1, 'in_progress', '')", [order.id]);
  await s.query("select public.set_order_status($1, 'completed', '')", [order.id]);
  const st = (await s.query<{ exceptions_fingerprint: string | null }>("select exceptions_fingerprint from public.billing_order_status where order_id = $1", [order.id])).rows[0];
  if (st?.exceptions_fingerprint) await s.query("select public.acknowledge_billing_exceptions($1, $2, 'Test')", [order.id, st.exceptions_fingerprint]);
  return order;
}

const leaks = async (s: Session, days = 1, checked = false) =>
  (await s.query<Leak>("select * from public.revenue_leaks($1, $2)", [days, checked])).rows;

describe("revenue leakage finder", () => {
  it("finds unbilled work, short billing and voided invoices; marks are checked and reopened by billing managers only", async () => {
    await withSession(async (s) => {
      const office = await s.createUser("office");
      const owner = await s.createUser("owner");
      const dispatcher = await s.createUser("dispatcher");

      // 1. Delivered and ready yesterday, not handed off: found once older than the limit.
      const ready = await delivered(s, office, 40);
      await s.as(owner);
      const notBilled = (await leaks(s, 1)).find((l) => l.order_id === ready.id && l.kind === "not_billed");
      expect(notBilled).toBeTruthy();
      expect(notBilled!.estimated).toBe(true);
      expect((await leaks(s, 7)).some((l) => l.order_id === ready.id && l.kind === "not_billed")).toBe(false);
      expect((await pgError(s.query("select * from public.revenue_leaks(0)"))).code).toBe("22023");

      // 2. Handed off for the ordered 40 t while the ticket says 45 t: 5 t × $10 short.
      const over = await delivered(s, office, 45);
      await s.as(office);
      await s.query("select public.hand_off_orders($1::uuid[], '', '', $2)", [[over.id], randomUUID()]);
      await s.as(owner);
      const short = (await leaks(s)).find((l) => l.order_id === over.id && l.kind === "billed_short");
      expect(short).toBeTruthy();
      expect(Number(short!.amount_cents)).toBe(5000);

      // 3. A Taviron invoice voided and not replaced.
      await s.query("select public.invoicing_save_settings('taviron', 30, '')");
      const h = (await s.query<{ id: string }>("select id from public.billing_handoff_orders where order_id = $1 and reverted_at is null", [over.id])).rows[0].id;
      const inv = (await s.query<{ r: string }>("select public.invoice_create($1) r", [h])).rows[0].r;
      await s.query("select public.invoice_issue($1, null)", [inv]);
      await s.query("select public.invoice_void($1, 'Wrong customer')", [inv]);
      expect((await leaks(s)).some((l) => l.kind === "voided_invoice" && l.order_id === over.id)).toBe(true);

      // Only billing readers see findings; only billing managers mark them.
      await s.as(dispatcher);
      expect((await pgError(s.query("select * from public.revenue_leaks()"))).code).toBe("42501");
      expect((await pgError(s.query("select public.revenue_leak_check($1, 'billed_short', 'Agreed with the customer')", [short!.finding_key]))).code).toBe("42501");

      // Checked: hidden, kept with its reason; reopened: shown again.
      await s.as(owner);
      expect((await pgError(s.query("select public.revenue_leak_check($1, 'billed_short', ' ')", [short!.finding_key]))).code).toBe("22023");
      expect((await pgError(s.query("select public.revenue_leak_check($1, 'not_billed', 'Mismatched kind')", [short!.finding_key]))).code).toBe("22023");
      await s.query("select public.revenue_leak_check($1, 'billed_short', 'Agreed with the customer')", [short!.finding_key]);
      expect((await leaks(s)).some((l) => l.finding_key === short!.finding_key)).toBe(false);
      expect((await leaks(s, 1, true)).find((l) => l.finding_key === short!.finding_key)?.checked_reason).toBe("Agreed with the customer");
      await s.query("select public.revenue_leak_reopen($1)", [short!.finding_key]);
      expect((await leaks(s)).some((l) => l.finding_key === short!.finding_key)).toBe(true);
      expect((await pgError(s.query("select public.revenue_leak_reopen($1)", [short!.finding_key]))).code).toBe("P0002");
      expect((await pgError(s.query("insert into public.revenue_leak_reviews (finding_key, kind, reason) values ('billed_short:x:y:z', 'billed_short', 'direct')"))).code).toBe("42501");

      // Another company sees none of these.
      const other = await s.createCompany("Leak Elsewhere (test)");
      const outsider = await s.createUser("owner", { companyId: other });
      await s.as(outsider);
      const theirs = await leaks(s, 1, true);
      expect(theirs.some((l) => [ready.id, over.id].includes(l.order_id))).toBe(false);
    });
  });
});
