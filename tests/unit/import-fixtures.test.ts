// Import dry run for Top Line's files (LR3, 2026-11-14): spreadsheets shaped like a small aggregate hauler's real
// exports (tests/fixtures/import/, fictional names only) go through the same reading and checks as the import preview.
// Row numbers must match the spreadsheet; every problem is explained in plain words; nothing here touches a database.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  decodeSpreadsheet, defaultsForMissing, displayValue, dryRun, guessMapping, mappingProblems, notCsvProblem, parseImportDate, prepareRows, readSheet,
  stateCodeOf, type ImportEntity,
} from "@/lib/platform/imports";

const TODAY = new Date("2026-11-14T12:00:00Z");
const fixture = (name: string) => decodeSpreadsheet(readFileSync(join(__dirname, "../fixtures/import", name)));
const run = (entity: ImportEntity, name: string) => dryRun(fixture(name), entity, TODAY);
const byRow = (r: ReturnType<typeof run>) => Object.fromEntries(r.rows.map((x) => [x.row, x]));

describe("reading files as Excel and Google Sheets save them", () => {
  it("decodes UTF-8 with a BOM, Excel's Windows encoding and UTF-16 text", () => {
    const utf8 = fixture("customers.csv");
    expect(utf8.startsWith("Customer List")).toBe(true); // BOM removed by readSheet; text decoded
    expect(utf8).toContain("Café Fictitious Concrete (test)");
    const ansi = fixture("customers-windows1252.csv");
    expect(ansi).toContain("Café Fictitious Concrete (test)");
    expect(ansi).toContain("O’Malley Make-Believe Excavating (test)");
    expect(ansi).not.toContain("�");
    const utf16 = fixture("trailers-utf16.txt");
    expect(utf16.split("\r\n")[0]).toBe("Trailer #\tType\tYear\tMake\tVIN\tPlate\tPlate State");
  });

  it("refuses workbooks and PDFs with a plain instruction", () => {
    expect(notCsvProblem("PK\u0003\u0004xl/workbook.xml")).toMatch(/Excel workbook.*CSV UTF-8/);
    expect(notCsvProblem("%PDF-1.7")).toMatch(/PDF/);
    expect(notCsvProblem("Name,Phone\r\nA,1")).toBeNull();
  });

  it("finds the column names below a title, skips blank rows and keeps spreadsheet row numbers", () => {
    const sheet = readSheet(fixture("customers.csv"));
    expect(sheet.skipped).toEqual(["Customer List (test)", "Printed 11/3/2026"]);
    expect(sheet.table[0][0]).toBe("Cust Name"); // trailing space trimmed
    expect(sheet.rowNumbers).toEqual([4, 5, 6, 8, 9, 10, 11, 12, 13]); // rows 7 and 14 are blank
    // A one-column list still works, and Excel's "sep=;" hint line is honoured.
    expect(readSheet("Material\nSand\nGravel").table).toEqual([["Material"], ["Sand"], ["Gravel"]]);
    expect(readSheet("sep=;\r\nName;Phone\r\nA;1\r\n").table).toEqual([["Name", "Phone"], ["A", "1"]]);
    // Old Mac line ends (CR only).
    expect(readSheet("Unit,Type\r101,tri axle\r102,tandem").rowNumbers).toEqual([1, 2, 3]);
  });

  it("keeps line breaks inside quoted cells and counts the row once", () => {
    const sites = run("sites", "job-sites.csv");
    expect(sites.rows[0]).toMatchObject({ row: 2, data: { directions: "Gate code 1234 (test)\nUse the east gate" } });
    expect(sites.rows.map((r) => r.row)).toEqual([2, 3, 4, 5, 6]);
  });
});

describe("column names people really use", () => {
  it("maps abbreviations, # signs, first/last names and combined headers", () => {
    const customers = run("customers", "customers.csv");
    expect(Object.fromEntries(customers.headers.map((h, i) => [h, customers.mapping[i]]))).toEqual({
      "Cust Name": "name", Contact: "", "Phone #": "phone", "E-mail": "email", Address: "billing_line1", City: "billing_city", ST: "billing_state",
      Zip: "billing_postal_code", Terms: "payment_terms", "PO Req?": "po_required", "Tax Exempt": "tax_exempt", Notes: "notes", Fax: "", "Acct #": "",
    });
    expect(customers.ignored).toEqual(["Contact", "Fax", "Acct #"]);
    const drivers = run("drivers", "drivers.csv");
    expect(drivers.mapping).toEqual(["name_last", "name_first", "employee_number", "phone", "hire_date", "", "cdl_class", "cdl_state", "cdl_expires_on", "cdl_endorsements", "medical_expires_on", ""]);
    expect(drivers.problems).toEqual([]);
    expect(guessMapping(["Gate Code / Notes", "Job Address"], "sites")).toEqual(["directions", "line1"]);
    expect(guessMapping(["Emp No.", "Driver Name", "Med Card Exp."], "drivers")).toEqual(["employee_number", "name", "medical_expires_on"]);
  });

  it("never maps an account or licence number to a name or a class", () => {
    // Before 2026-11-14 "Customer #" became the name and "CDL #" the CDL class (the # sign was dropped).
    expect(guessMapping(["Customer #", "Customer Name"], "customers")).toEqual(["", "name"]);
    expect(guessMapping(["CDL #", "CDL Class"], "drivers")).toEqual(["", "cdl_class"]);
  });

  it("asks for a name column, or first and last name, but not both", () => {
    expect(mappingProblems(["name_first", "name_last"], "drivers")).toEqual([]);
    expect(mappingProblems(["employee_number"], "drivers")).toEqual(['Choose the column for "Name" (or the first and last name columns).']);
    expect(mappingProblems(["name", "name_first"], "drivers")).toEqual(['Use either the "Name" column or the first and last name columns, not both.']);
  });
});

describe("values and plain-word problems, per entity", () => {
  it("customers: trims, normalizes phones, states and emails, explains each problem", () => {
    const c = run("customers", "customers.csv");
    const r = byRow(c);
    expect(r[5]).toMatchObject({ errors: [], data: { name: "Gravel Gulch Paving (test)", phone: "(219) 555-0101", email: "ap@gravelgulch.test", billing_state: "IN", po_required: "true", tax_exempt: "false" } });
    expect(r[6].data).toMatchObject({ phone: "(219) 555-0102", billing_state: "IN", billing_line1: "2 Mill St, Suite 4", po_required: "true" });
    expect(r[8].data.name).toBe("Pretend Pipe & Drain (test)");
    expect(r[8].errors).toEqual(['Email has more than one address ("billing@pretendpipe.test; sam@pretendpipe.test"). Keep one here and put the others in Notes.']);
    expect(r[10].data).not.toHaveProperty("email"); // "N/A" is blank, not an error
    expect(r[10].data).not.toHaveProperty("po_required");
    expect(r[10].errors).toEqual(['ZIP / postal code "6342" has only 4 digits: Excel probably dropped a leading zero. Format the column as Text and type the full ZIP code.']);
    expect(r[11].errors).toEqual(["Phone shows a spreadsheet error (#N/A) instead of a value. Fix that cell in the spreadsheet or clear it."]);
    expect(r[12].data).toMatchObject({ name: "Nonesuch Nurseries (test)", phone: "(219) 555-0106 x12" }); // non-breaking space
    expect(r[13].data.phone).toBe("+1 (219) 555-0107");
    expect(c.rows.filter((x) => x.errors.length).map((x) => x.row)).toEqual([8, 10, 11]);
    expect(c.defaults).toEqual([{ label: "Type", value: "Commercial" }]);
  });

  it("contacts: the same customer list read as contacts, and a contacts file with first and last names", () => {
    const fromCustomers = byRow(run("contacts", "customers.csv"));
    expect(fromCustomers[5].data).toEqual({ customer_name: "Gravel Gulch Paving (test)", name: "Dana Fictional", phone: "(219) 555-0101", email: "ap@gravelgulch.test" });
    expect(fromCustomers[9].errors).toEqual(["Contact name is required."]);
    const contacts = run("contacts", "contacts.csv");
    expect(contacts.mapping).toEqual(["customer_name", "name_first", "name_last", "title", "phone", "email", "is_billing"]);
    expect(contacts.rows.map((r) => [r.row, r.data.name, r.data.is_billing ?? null])).toEqual([
      [2, "Dana Fictional", "true"], [3, "Chris Placeholder", "false"], [4, "Pat Nobody", null], [5, "Morgan", null], [6, "dana fictional", null],
    ]);
  });

  it("job sites: state names become codes; a blank site name and state are shown as what they will be", () => {
    const sites = run("sites", "job-sites.csv");
    expect(sites.rows[1].data).toEqual({ customer_name: "Fictional Earthworks LLC (test)", line1: "77 Sample Pkwy", city: "Chesterton", state: "IN", postal_code: "46304" });
    expect(defaultsForMissing(["customer_name", "line1"], "sites")).toEqual([{ label: "Site name", value: "the street address" }, { label: "State", value: "IN" }]);
  });

  it("materials: units as people write them, codes the database accepts, prices left for the price list", () => {
    const m = run("materials", "materials.csv");
    expect(m.ignored).toEqual(["Price/Ton"]);
    expect(m.rows.map((r) => r.data.default_unit_code ?? null)).toEqual(["ton", "ton", "cu_yd", "cu_yd", "load", null, "ton"]);
    expect(byRow(m)[4].errors).toEqual(['Code "TOP SOIL" can use only letters, numbers, dots, dashes and underscores (at most 30), like 57-STONE.']);
    expect(byRow(m)[7].errors[0]).toMatch(/^Unit "bucket" is not recognized\. Use one of: Ton, Load, Cubic yard/);
    expect(m.defaults).toEqual([]);
    expect(displayValue("materials", "default_unit_code", "cu_yd")).toBe("Cubic yard");
  });

  it("trucks: leading zeros kept, VINs and plate states checked as the database will", () => {
    const t = byRow(run("trucks", "trucks.csv"));
    expect(t[2].data).toMatchObject({ unit_number: "007", vin: "1M2GR4GC5KM000001", plate_state: "IN", truck_type: "tri_axle_dump" });
    expect(t[3].errors[0]).toMatch(/^VIN "1NKZL40X0GJ00000" is not a full VIN: it has 17 letters and numbers, never I, O or Q/);
    expect(t[3].data.plate_state).toBe("IN"); // "Indiana"
    expect(t[4].data).toMatchObject({ unit_number: "0015", plate_state: "IN", truck_type: "quad_axle_dump" });
    expect(t[5].data.unit_number).toBe("007"); // the database flags it as the same unit as row 2
    expect(t[6].errors[0]).toMatch(/^Truck type "10 wheeler" is not recognized\. Use one of: Single-axle dump/);
    expect(t[7].errors).toEqual(['Year "2030" is not a year between 1950 and 2027.']);
    expect(t[8].data).toMatchObject({ license_plate: "TRK 1007", truck_type: "straight_truck" });
    expect(displayValue("trucks", "truck_type", "tri_axle_dump")).toBe("Tri-axle dump");
  });

  it("trailers: a UTF-16 tab-separated export", () => {
    const t = run("trailers", "trailers-utf16.txt");
    expect(t.rows.map((r) => [r.row, r.data.trailer_type ?? null, r.data.plate_state ?? null])).toEqual([[2, "end_dump", "IN"], [3, "belly_dump", "IN"], [4, null, "IN"], [5, "end_dump", "IN"]]);
  });

  it("drivers: joined names, US dates with two-digit years, Excel date numbers, CDL rules", () => {
    const d = byRow(run("drivers", "drivers.csv"));
    expect(d[2]).toMatchObject({
      errors: [],
      data: { name: "Alex Testdriver (test)", employee_number: "0042", phone: "(219) 555-0121", hire_date: "1998-05-01", cdl_class: "A", cdl_state: "IN", cdl_expires_on: "2026-11-03", cdl_endorsements: "N, T", medical_expires_on: "2027-11-03" },
    });
    expect(d[3].data).toMatchObject({ cdl_state: "IN", cdl_expires_on: "2028-02-29" });
    expect(d[3].errors).toEqual(['Medical card expires "46329" is an Excel date number, not a date. In Excel, format the column as a date (like 11/3/2026) and save the file again.']);
    expect(d[4]).toMatchObject({ errors: [], data: { hire_date: "2026-11-03" } });
    expect(d[4].data).not.toHaveProperty("cdl_class"); // "Non-CDL"
    expect(d[4].data).not.toHaveProperty("medical_expires_on"); // "N/A"
    expect(d[5].errors).toEqual(['CDL expires "13/1/2027" is not a date. Use month/day/year, like 11/3/2026.']);
    expect(d[6].data).toMatchObject({ name: "Taylor O’Fiction (test)", cdl_class: "C", cdl_endorsements: "H" });
    expect(d[8].errors).toEqual(["A CDL expiry needs the CDL class."]);
    expect(Object.keys(d).map(Number)).toEqual([2, 3, 4, 5, 6, 8]); // row 7 is blank
  });
});

describe("value readers", () => {
  it("reads dates the way US spreadsheets show them", () => {
    const cases: Array<[string, string | null]> = [
      ["11/3/2026", "2026-11-03"], ["11/03/26", "2026-11-03"], ["11-3-2026", "2026-11-03"], ["11.3.2026", "2026-11-03"], ["2026-11-03", "2026-11-03"],
      ["2026/11/3", "2026-11-03"], ["3-Nov-26", "2026-11-03"], ["03 Nov 2026", "2026-11-03"], ["Nov 3, 2026", "2026-11-03"], ["November 3rd 2026", "2026-11-03"],
      ["Sept 30, 2027", "2027-09-30"], ["11/3/2026 0:00", "2026-11-03"], ["11/3/2026 12:00 AM", "2026-11-03"], ["2026-11-03T00:00:00Z", "2026-11-03"],
      ["5/1/98", "1998-05-01"], ["1/1/56", "2056-01-01"], ["1/1/57", "1957-01-01"], ["2/29/2027", null], ["13/1/2027", null], ["soon", null], ["1/1/1850", null],
    ];
    for (const [v, want] of cases) expect([v, parseImportDate(v, TODAY)]).toEqual([v, want]);
    expect(parseImportDate("46329", TODAY)).toBe("serial");
  });

  it("reads states and provinces by name, code or short form", () => {
    expect(["IN", "in", "Indiana", "indiana ", "Ind.", "Ill.", "New York", "Ontario"].map(stateCodeOf)).toEqual(["IN", "IN", "IN", "IN", "IN", "IL", "NY", "ON"]);
    expect(["Indianna", "XX", "Hoosier"].map(stateCodeOf)).toEqual([null, null, null]);
  });

  it("refuses values Excel rounded or broke, and multi-value cells, with what to do", () => {
    const rows = prepareRows(
      [["Unit", "Type", "Plate"], ["1.23E+05", "tandem", "5.5E+09"], ["#REF!", "tandem", ""]],
      ["unit_number", "truck_type", "license_plate"], "trucks", TODAY,
    );
    expect(rows[0].errors).toEqual([
      'Unit number "1.23E+05" was rounded by Excel. Format the column as Text, type the values again and save.',
      'License plate "5.5E+09" was rounded by Excel. Format the column as Text, type the values again and save.',
    ]);
    expect(rows[1].errors).toEqual(["Unit number shows a spreadsheet error (#REF!) instead of a value. Fix that cell in the spreadsheet or clear it."]);
    const phones = prepareRows([["Name", "Phone"], ["A", "219-555-0101 / 219-555-0102"], ["B", "call office"], ["C", "555-0142"]], ["name", "phone"], "customers", TODAY);
    expect(phones.map((r) => r.errors[0] ?? r.data.phone)).toEqual([
      'Phone has more than one number ("219-555-0101 / 219-555-0102"). Keep one here and put the other in Notes.',
      'Phone "call office" is not a phone number.',
      "555-0142", // seven digits are kept as written, like the app's own forms
    ]);
  });

  it("checks lengths the database enforces before approval, not during it", () => {
    const long = "x".repeat(21);
    expect(prepareRows([["Unit", "Type"], [long, "tandem"]], ["unit_number", "truck_type"], "trucks", TODAY)[0].errors).toEqual(["Unit number is too long (21 characters; at most 20)."]);
    expect(prepareRows([["Name"], ["y".repeat(161)]], ["name"], "customers", TODAY)[0].errors).toEqual(["Name is too long (161 characters; at most 160)."]);
    expect(prepareRows([["Customer", "Address"], ["C", "z".repeat(130)]], ["customer_name", "line1"], "sites", TODAY)[0].errors).toEqual([
      "Site name is needed: the street address is too long to use as the name (at most 120 characters).",
    ]);
  });
});
