// Quote edits in the quote's History (owner walkthrough WK1; migration 20261120019000_quote_history_read). The quote
// page reads the quote's audit entries with the person's own session: with the update, everyone who can open quotes
// (quotes.view) reads them, owners and office alike; nobody without quotes.view, and never another company's. The
// update is applied inside each test's transaction (rolled back), so this runs the same whether or not it is installed
// on the local database, and its rollback script is exercised too.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { pool, sampleIds, saveQuote, withSession, type Session } from "./helpers";

afterAll(() => pool.end());

const migration = readFileSync(join(__dirname, "../../supabase/migrations/20261120019000_quote_history_read.sql"), "utf8");
// The rollback without its own begin/commit (the test's transaction wraps it).
const rollback = readFileSync(join(__dirname, "../../supabase/rollbacks/20261120019000_quote_history_read.down.sql"), "utf8")
  .replace(/^\s*begin;\s*$/m, "").replace(/^\s*commit;\s*$/m, "");

async function editedQuote(s: Session) {
  const ids = await sampleIds(s);
  const office = await s.createUser("office");
  await s.as(office);
  const line = { kind: "material", calc_method: "per_unit", material_id: ids.gravelId, description: "Gravel #53 limestone", unit_code: "ton", quantity: "10", unit_rate_cents: 1000, taxable: true };
  const created = await saveQuote(s, { customer_id: ids.customerId, quote_date: "2026-10-01", valid_until: "2026-10-31", tax_rate_bp: 0, lines: [line] });
  // An edit of the draft: a new quantity.
  await saveQuote(s, { quote_id: created.quote_id, expected_edit_seq: created.edit_seq, customer_id: ids.customerId, quote_date: "2026-10-01", valid_until: "2026-10-31", tax_rate_bp: 0, lines: [{ ...line, quantity: "12" }] });
  return { office, quoteId: created.quote_id };
}

const historyOf = (s: Session, quoteId: string) =>
  s.query<{ action: string }>("select action from public.audit_events where entity_type = 'quote' and entity_id = $1 order by occurred_at", [quoteId]);

describe("quote edits in the quote's History", () => {
  it("office staff (quotes.view, no audit.view) read the quote's created and edited entries once the update is installed", async () => {
    await withSession(async (s) => {
      await s.asAdmin();
      await s.query(migration);
      const { office, quoteId } = await editedQuote(s);
      await s.as(office);
      const actions = (await historyOf(s, quoteId)).rows.map((r) => r.action);
      expect(actions).toContain("quote.created");
      expect(actions).toContain("quote.updated");
      // Only the quote's entries: other audit entries stay owner-only (audit.view).
      const other = await s.query("select 1 from public.audit_events where entity_type not in ('quote', 'order', 'truck', 'trailer', 'driver', 'driver_qualification') limit 1");
      expect(other.rowCount).toBe(0);
    });
  });

  it("people without quotes.view and other companies read none of them", async () => {
    await withSession(async (s) => {
      await s.asAdmin();
      await s.query(migration);
      const { quoteId } = await editedQuote(s);
      await s.asAdmin();
      const mechanic = await s.createUser("mechanic");
      const otherCompany = await s.createCompany("Quote History Other Co (test)");
      const otherOwner = await s.createUser("owner", { companyId: otherCompany });
      await s.query("update public.profiles set active_company_id = $1 where id = $2", [otherCompany, otherOwner]);
      await s.as(mechanic);
      expect((await historyOf(s, quoteId)).rowCount).toBe(0);
      await s.as(otherOwner);
      expect((await historyOf(s, quoteId)).rowCount).toBe(0);
    });
  });

  it("the rollback removes the read again: office staff then see none, owners still do", async () => {
    await withSession(async (s) => {
      await s.asAdmin();
      await s.query(migration);
      const { office, quoteId } = await editedQuote(s);
      await s.asAdmin();
      await s.query(rollback);
      const owner = await s.createUser("owner");
      await s.as(office);
      expect((await historyOf(s, quoteId)).rowCount).toBe(0);
      await s.as(owner);
      expect((await historyOf(s, quoteId)).rows.map((r) => r.action)).toEqual(expect.arrayContaining(["quote.created", "quote.updated"]));
      // Re-applying after the rollback works (apply → rollback → re-apply).
      await s.asAdmin();
      await s.query(migration);
      await s.as(office);
      expect((await historyOf(s, quoteId)).rowCount).toBeGreaterThanOrEqual(2);
    });
  });
});
