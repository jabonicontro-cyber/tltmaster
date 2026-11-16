// Import dry run for Top Line's files (LR3, migration 20261120021000): the fictional spreadsheets in
// tests/fixtures/import/ go through the real pipeline: the preview's reading and checks (src/lib/platform/imports.ts),
// then the database's staging (duplicates against existing records and within the file), review decisions, approval
// all at once, and undo. Contacts are a new import kind; staging now refuses what approval would refuse.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { decodeSpreadsheet, dryRun, type ImportEntity } from "@/lib/platform/imports";
import { pgError, pool, withSession, type Session } from "./helpers";

afterAll(() => pool.end());

const TODAY = new Date("2026-11-14T12:00:00Z");
const MIGRATION = "20261120021000_import_contacts_checks";
type Staged = { status: string; rows: Array<{ id: string; row: number; status: string; decision: string; can_override: boolean; messages: string[]; outcome: string }> };

/** What the uploader sends for a fixture: rows as prepared by the preview (data and errors, spreadsheet row numbers). */
function prepared(entity: ImportEntity, file: string) {
  const run = dryRun(decodeSpreadsheet(readFileSync(join(__dirname, "../fixtures/import", file))), entity, TODAY);
  expect(run.problems).toEqual([]);
  const mapping = Object.fromEntries(run.headers.map((h, i) => [h, run.mapping[i]]).filter(([, k]) => k));
  return { mapping, rows: run.rows.map((r) => ({ row: r.row, data: r.data, errors: r.errors })) };
}

async function stage(s: Session, entity: ImportEntity, file: string) {
  const { mapping, rows } = prepared(entity, file);
  const id = (await s.query<{ r: string }>("select public.company_import_stage($1, $2, $3::jsonb, $4::jsonb) r", [entity, file, JSON.stringify(mapping), JSON.stringify(rows)])).rows[0].r;
  return { id, batch: await batch(s, id) };
}
const batch = async (s: Session, id: string) => (await s.query<{ r: Staged }>("select public.company_import_batch($1) r", [id])).rows[0].r;
const statuses = (b: Staged) => b.rows.map((r) => [r.row, r.status]);
const approve = async (s: Session, id: string) => (await s.query<{ r: { created: number } }>("select public.company_import_approve($1) r", [id])).rows[0].r.created;

describe("Top Line import dry run with realistic files (LR3)", () => {
  it("customers, contacts, job sites, materials, trucks, trailers and drivers: preview, stage, review, approve, undo", async () => {
    await withSession(async (s) => {
      const company = await s.createCompany("Import Dry Run Hauling (test)");
      const owner = await s.createUser("owner", { companyId: company });
      await s.as(owner);

      // Customers: a title row, blank rows, a duplicate written in lower case, three rows that need fixing.
      const customers = await stage(s, "customers", "customers.csv");
      expect(statuses(customers.batch)).toEqual([[5, "valid"], [6, "valid"], [8, "error"], [9, "duplicate"], [10, "error"], [11, "error"], [12, "valid"], [13, "valid"]]);
      expect(customers.batch.rows.find((r) => r.row === 9)?.messages).toEqual(["Same as row 5 of this file."]);
      expect((await s.query("select 1 from public.customers where name like '%(test)' and company_id = $1", [company])).rowCount).toBe(0); // nothing yet
      expect(await approve(s, customers.id)).toBe(4);
      const gravel = (await s.query<{ phone: string; email: string; billing_state: string; po_required: boolean; customer_type: string }>(
        "select phone, email, billing_state, po_required, customer_type::text from public.customers where name = 'Gravel Gulch Paving (test)'")).rows;
      expect(gravel).toEqual([{ phone: "(219) 555-0101", email: "ap@gravelgulch.test", billing_state: "IN", po_required: true, customer_type: "commercial" }]);
      expect((await s.query("select 1 from public.customers where name = 'Nonesuch Nurseries (test)'")).rowCount).toBe(1); // non-breaking space normalized

      // Contacts (new kind): matched to customers by name; an unknown customer and an in-file repeat are not imported.
      const contacts = await stage(s, "contacts", "contacts.csv");
      expect(statuses(contacts.batch)).toEqual([[2, "valid"], [3, "valid"], [4, "error"], [5, "valid"], [6, "duplicate"]]);
      expect(contacts.batch.rows[2].messages).toEqual(["No customer with this name. Import or add the customer first."]);
      expect(await approve(s, contacts.id)).toBe(3);
      const people = (await s.query<{ customer: string; name: string; title: string; is_billing: boolean; is_primary: boolean }>(
        `select c.name customer, x.name, x.title, x.is_billing, x.is_primary from public.customer_contacts x join public.customers c on c.id = x.customer_id
          where x.company_id = $1 order by x.name`, [company])).rows;
      expect(people).toEqual([
        { customer: "Gravel Gulch Paving (test)", name: "Chris Placeholder", title: "Foreman", is_billing: false, is_primary: false },
        { customer: "Gravel Gulch Paving (test)", name: "Dana Fictional", title: "Office manager", is_billing: true, is_primary: false },
        { customer: "Fictional Earthworks LLC (test)", name: "Morgan", title: "Owner", is_billing: false, is_primary: false },
      ]);
      // The customer list read again as contacts: Dana already exists for Gravel Gulch (a possible duplicate the reviewer may still import).
      const again = await stage(s, "contacts", "customers.csv");
      const dana = again.batch.rows.find((r) => r.row === 5)!;
      expect([dana.status, dana.can_override, dana.messages]).toEqual(["duplicate", true, ["A contact with this name already exists for this customer."]]);

      // Job sites: a blank site name becomes the street address; a blank state is IN, as the preview says.
      const sites = await stage(s, "sites", "job-sites.csv");
      expect(statuses(sites.batch)).toEqual([[2, "valid"], [3, "valid"], [4, "duplicate"], [5, "error"], [6, "valid"]]);
      expect(await approve(s, sites.id)).toBe(3);
      const siteRows = (await s.query<{ label: string; state: string; directions: string }>("select label, state, directions from public.customer_sites where company_id = $1 order by label", [company])).rows;
      expect(siteRows).toEqual([
        { label: "77 Sample Pkwy", state: "IN", directions: "" },
        { label: "Greenhouse 2 (test)", state: "IN", directions: "" },
        { label: "North Pit Lot (test)", state: "IN", directions: "Gate code 1234 (test)\nUse the east gate" },
      ]);

      // Materials: units read as written; a code with a space and an unknown unit need fixing; "fill sand" repeats row 3.
      const materials = await stage(s, "materials", "materials.csv");
      expect(statuses(materials.batch)).toEqual([[2, "valid"], [3, "valid"], [4, "error"], [5, "valid"], [6, "valid"], [7, "error"], [8, "duplicate"]]);
      expect(await approve(s, materials.id)).toBe(4);
      expect((await s.query<{ default_unit_code: string; taxable_default: boolean }>("select default_unit_code, taxable_default from public.materials where name = 'Fill Sand (test)'")).rows)
        .toEqual([{ default_unit_code: "ton", taxable_default: true }]);

      // Trucks: leading zeros kept; "007 " repeats "007"; a short VIN, an unknown type and a future year need fixing.
      const trucks = await stage(s, "trucks", "trucks.csv");
      expect(statuses(trucks.batch)).toEqual([[2, "valid"], [3, "error"], [4, "valid"], [5, "duplicate"], [6, "error"], [7, "error"], [8, "valid"]]);
      expect(await approve(s, trucks.id)).toBe(3);
      expect((await s.query<{ unit_number: string; vin: string; plate_state: string }>("select unit_number, vin, plate_state from public.trucks where company_id = $1 order by unit_number", [company])).rows).toEqual([
        { unit_number: "0015", vin: "", plate_state: "IN" },
        { unit_number: "007", vin: "1M2GR4GC5KM000001", plate_state: "IN" },
        { unit_number: "23", vin: "1FDUF5HT0LDA00023", plate_state: "OH" },
      ]);

      // Trailers from a UTF-16 tab-separated export.
      const trailers = await stage(s, "trailers", "trailers-utf16.txt");
      expect(statuses(trailers.batch)).toEqual([[2, "valid"], [3, "valid"], [4, "error"], [5, "duplicate"]]);
      expect(await approve(s, trailers.id)).toBe(2);

      // Drivers: first and last names joined; CDL and medical dates recorded unverified, with endorsements.
      const drivers = await stage(s, "drivers", "drivers.csv");
      expect(statuses(drivers.batch)).toEqual([[2, "valid"], [3, "error"], [4, "valid"], [5, "error"], [6, "valid"], [8, "error"]]);
      expect(drivers.batch.rows[3].messages).toEqual(['CDL expires "13/1/2027" is not a date. Use month/day/year, like 11/3/2026.', "Same as row 2 of this file."]);
      // Found by the preview and again by the database: listed once.
      expect(drivers.batch.rows[5].messages).toEqual(["A CDL expiry needs the CDL class."]);
      expect(await approve(s, drivers.id)).toBe(3);
      const quals = (await s.query<{ name: string; hire_date: string | null; kind: string; cdl_class: string | null; issuing_state: string; expires_on: string | null; endorsements: string; verified_at: string | null }>(
        `select d.name, d.hire_date::text, q.kind::text, q.cdl_class::text, q.issuing_state, q.expires_on::text, q.endorsements, q.verified_at
           from public.drivers d left join public.driver_qualifications q on q.driver_id = d.id where d.company_id = $1 order by d.name, q.kind`, [company])).rows;
      expect(quals).toEqual([
        { name: "Alex Testdriver (test)", hire_date: "1998-05-01", kind: "cdl", cdl_class: "A", issuing_state: "IN", expires_on: "2026-11-03", endorsements: "N, T", verified_at: null },
        { name: "Alex Testdriver (test)", hire_date: "1998-05-01", kind: "medical_card", cdl_class: null, issuing_state: "", expires_on: "2027-11-03", endorsements: "", verified_at: null },
        { name: "Casey Madeup (test)", hire_date: "2026-11-03", kind: null, cdl_class: null, issuing_state: null, expires_on: null, endorsements: null, verified_at: null },
        { name: "Taylor O’Fiction (test)", hire_date: null, kind: "cdl", cdl_class: "C", issuing_state: "IN", expires_on: null, endorsements: "H", verified_at: null },
      ]);

      // Undo the contacts: inactive, never deleted.
      const undo = (await s.query<{ r: { deactivated: number } }>("select public.company_import_undo($1, 'Dry run (test)') r", [contacts.id])).rows[0].r;
      expect(undo.deactivated).toBe(3);
      expect((await s.query("select 1 from public.customer_contacts where company_id = $1 and active", [company])).rowCount).toBe(0);
      expect((await s.query("select 1 from public.customer_contacts where company_id = $1", [company])).rowCount).toBe(3);
    });
  });

  it("staging refuses what approval would refuse, even when the browser's checks are skipped", async () => {
    await withSession(async (s) => {
      const company = await s.createCompany("Import Staging Checks (test)");
      const owner = await s.createUser("owner", { companyId: company });
      await s.as(owner);
      const raw = (entity: string, rows: Array<Record<string, string>>) =>
        s.query<{ r: string }>("select public.company_import_stage($1, 'raw.csv', '{}', $2::jsonb) r", [entity, JSON.stringify(rows.map((data, i) => ({ row: i + 2, data })))]).then((x) => batch(s, x.rows[0].r));
      const trucks = await raw("trucks", [
        { unit_number: "T1", truck_type: "tandem_axle_dump", vin: "1m2gr4gc5km000001" },
        { unit_number: "T2", truck_type: "tandem_axle_dump", plate_state: "Indiana" },
        { unit_number: "T".repeat(21), truck_type: "tandem_axle_dump" },
        { unit_number: "T4", truck_type: "tandem_axle_dump", license_plate: "P".repeat(16), model_year: "19x" },
        { unit_number: "T5", truck_type: "tandem_axle_dump", vin: "1M2GR4GC5KM000001", plate_state: "IN", model_year: "2019" },
      ]);
      expect(trucks.rows.map((r) => [r.status, r.messages])).toEqual([
        ["error", ["VIN must be 17 capital letters and numbers, without I, O or Q (or left blank)."]],
        ["error", ["Plate state must be two letters, like IN."]],
        ["error", ["Unit number is longer than 20 characters."]],
        ["error", ["License plate is longer than 15 characters.", "Year is not a valid year."]],
        ["valid", []],
      ]);
      const materials = await raw("materials", [{ name: "Sand (test)", default_unit_code: "ton", code: "TOP SOIL" }, { name: "m".repeat(121), default_unit_code: "ton" }]);
      expect(materials.rows.map((r) => r.messages)).toEqual([["Code can use only letters, numbers, dots, dashes and underscores (at most 30)."], ["Name is longer than 120 characters."]]);
      const drivers = await raw("drivers", [{ name: "D (test)", employee_number: "E".repeat(21), hire_date: "someday" }, { name: "E (test)", cdl_endorsements: "T", cdl_state: "IN" }]);
      expect(drivers.rows.map((r) => r.messages)).toEqual([
        ["Hire date is not a date.", "Employee number is longer than 20 characters."],
        ["A CDL state needs the CDL class.", "CDL endorsements need the CDL class."],
      ]);
      const contacts = await raw("contacts", [{ customer_name: "Nobody (test)", name: "" }]);
      expect(contacts.rows[0].messages).toEqual(["No customer with this name. Import or add the customer first.", "Contact name is required."]);
      // Approving the valid rows works; the error rows are never imported.
      const id = (await s.query<{ id: string }>("select id from public.company_import_batches() where entity = 'trucks'")).rows[0].id;
      expect(await approve(s, id)).toBe(1);
    });
  });

  it("the platform team's revert refuses job-site, trailer and contact batches (they are undone by the company)", async () => {
    await withSession(async (s) => {
      const company = await s.createCompany("Import Revert Guard (test)");
      await s.asAdmin();
      await s.query("insert into public.customers (company_id, name) values ($1, 'Guard Customer (test)')", [company]);
      const admin = await s.createUser(null, { membership: false });
      const email = (await s.query<{ email: string }>("select email from auth.users where id = $1", [admin])).rows[0].email;
      await s.query("set local role service_role");
      await s.query("select public.platform_admin_grant($1, 'test')", [email]);
      await s.as(admin);
      const id = (await s.query<{ r: string }>("select public.platform_import_stage($1, 'contacts', 'c.csv', '{}', $2::jsonb) r",
        [company, JSON.stringify([{ row: 2, data: { customer_name: "Guard Customer (test)", name: "Pat Example" } }])])).rows[0].r;
      await s.query("select public.platform_import_approve($1)", [id]);
      const err = await pgError(s.query("select public.platform_import_revert($1, 'test')", [id]));
      expect(err.code).toBe("22023");
      expect(err.message).toMatch(/Undo job-site, trailer and contact imports from the company's Settings/);
      await s.asAdmin();
      expect((await s.query("select 1 from public.customer_contacts where company_id = $1 and active", [company])).rowCount).toBe(1); // untouched
    });
  });

  it("the rollback restores the previous functions and the migration applies again", { retry: 2 }, async () => {
    await withSession(async (s) => {
      await s.asAdmin();
      await s.query(readFileSync(join(__dirname, `../../supabase/rollbacks/${MIGRATION}.down.sql`), "utf8"));
      expect((await s.query<{ f: string[] | null }>("select private.import_fields('contacts') f")).rows[0].f).toBeNull();
      expect((await s.query<{ f: string[] }>("select private.import_fields('drivers') f")).rows[0].f).not.toContain("cdl_endorsements");
      await s.query(readFileSync(join(__dirname, `../../supabase/migrations/${MIGRATION}.sql`), "utf8"));
      expect((await s.query<{ f: string[] }>("select private.import_fields('contacts') f")).rows[0].f).toEqual(["customer_name", "name", "title", "email", "phone", "is_billing", "notes"]);
    });
  });
});
