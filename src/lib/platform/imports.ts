// Spreadsheet imports (the platform team's onboarding imports and a company's own, B106): reading the file, column
// mapping and row validation. The same code runs in the browser (preview while mapping) and on the server (the
// authoritative check before staging); the database checks required fields, allowed values and duplicates once more.
// Files are read as people really export them (LR3 dry run, 2026-11-14): Excel CSV in UTF-8 or Windows encoding, a
// title row above the column names, blank rows, abbreviated headers ("Cust Name", "Phone #", "Emp No."), values such
// as "N/A", US dates with two-digit years, state names, phone numbers in any format. Row numbers always match the
// spreadsheet, so "row 7" in the preview is row 7 in Excel.

import { formatDate } from "@/lib/dates";
import { TRAILER_TYPE_LABELS, TRUCK_TYPE_LABELS } from "@/lib/fleet/labels";
import { formatPhone } from "@/lib/phone";

export const IMPORT_ENTITIES = ["customers", "contacts", "sites", "materials", "trucks", "trailers", "drivers"] as const;
export type ImportEntity = (typeof IMPORT_ENTITIES)[number];

type FieldType =
  | "text" // one line: spaces trimmed and runs of spaces collapsed
  | "multiline" // notes and directions: line breaks kept
  | "ident" // unit and employee numbers: kept exactly (leading zeros too), refused when Excel rounded them
  | "email"
  | "phone"
  | "bool"
  | "int"
  | "date"
  | "choice"
  | "state"
  | "zip"
  | "vin"
  | "code";

export interface ImportField {
  key: string;
  label: string;
  required?: boolean;
  type: FieldType;
  max?: number;
  /** Header names that map to this field automatically (compared without case, spaces or punctuation). */
  aliases: string[];
  /** For choices: accepted spellings → stored value. */
  choices?: Record<string, string>;
  /** For choices: the stored value → the words people see (preview, review, error messages). */
  choiceLabels?: Record<string, string>;
  /** What the record gets when the cell is blank or the column is not in the file (shown in the preview). */
  blankMeans?: string;
  /**
   * Not stored on its own: first and last name columns are joined into the full name. Templates leave these out
   * (they use the full name).
   */
  partOf?: string;
}

const TRUCK_TYPES: Record<string, string> = {
  singleaxle: "single_axle_dump", singleaxledump: "single_axle_dump", single: "single_axle_dump", singledump: "single_axle_dump",
  tandem: "tandem_axle_dump", tandemaxle: "tandem_axle_dump", tandemaxledump: "tandem_axle_dump", tandemdump: "tandem_axle_dump",
  triaxle: "tri_axle_dump", triaxledump: "tri_axle_dump", tri: "tri_axle_dump", tridump: "tri_axle_dump", triaxel: "tri_axle_dump",
  quadaxle: "quad_axle_dump", quadaxledump: "quad_axle_dump", quad: "quad_axle_dump", quaddump: "quad_axle_dump",
  tractor: "tractor", semi: "tractor", semitractor: "tractor", trucktractor: "tractor", straighttruck: "straight_truck", boxtruck: "straight_truck", box: "straight_truck", straight: "straight_truck", other: "other",
};
const TRAILER_TYPES: Record<string, string> = {
  enddump: "end_dump", end: "end_dump", bellydump: "belly_dump", belly: "belly_dump", bottomdump: "belly_dump", sidedump: "side_dump", side: "side_dump",
  livefloor: "live_floor", walkingfloor: "live_floor", pup: "pup", puptrailer: "pup",
  dryvan: "dry_van", van: "dry_van", "53van": "dry_van", "53dryvan": "dry_van", "53ftdryvan": "dry_van", "53ftvan": "dry_van", reefer: "reefer", refrigerated: "reefer", flatbed: "flatbed", flat: "flatbed",
  stepdeck: "step_deck", dropdeck: "step_deck", lowboy: "lowboy", rgn: "lowboy", other: "other",
};
const CDL_CLASSES: Record<string, string> = { a: "A", classa: "A", cdla: "A", b: "B", classb: "B", cdlb: "B", c: "C", classc: "C", cdlc: "C" };
const UNITS: Record<string, string> = {
  ton: "ton", tons: "ton", t: "ton", tn: "ton", tns: "ton",
  load: "load", loads: "load", ld: "load", lds: "load",
  cuyd: "cu_yd", cuyds: "cu_yd", cy: "cu_yd", cyd: "cu_yd", yd: "cu_yd", yds: "cu_yd", yard: "cu_yd", yards: "cu_yd", cubicyard: "cu_yd", cubicyards: "cu_yd", cubicyd: "cu_yd",
  hour: "hour", hours: "hour", hr: "hour", hrs: "hour", hourly: "hour",
  mile: "mile", miles: "mile", mi: "mile",
  day: "day", days: "day", daily: "day",
  each: "each", ea: "each",
};
const UNIT_LABELS: Record<string, string> = { ton: "Ton", load: "Load", cu_yd: "Cubic yard", hour: "Hour", mile: "Mile", day: "Day", each: "Each" };
const CUSTOMER_TYPES: Record<string, string> = {
  commercial: "commercial", business: "commercial", company: "commercial", contractor: "commercial",
  residential: "residential", homeowner: "residential", individual: "residential", private: "residential",
};
const CUSTOMER_TYPE_LABELS: Record<string, string> = { commercial: "Commercial", residential: "Residential" };

// US states, DC and territories, and Canadian provinces: full name → two-letter code.
const STATE_NAMES: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO", connecticut: "CT", delaware: "DE",
  districtofcolumbia: "DC", florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA",
  kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI", minnesota: "MN",
  mississippi: "MS", missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV", newhampshire: "NH", newjersey: "NJ", newmexico: "NM",
  newyork: "NY", northcarolina: "NC", northdakota: "ND", ohio: "OH", oklahoma: "OK", oregon: "OR", pennsylvania: "PA", rhodeisland: "RI",
  southcarolina: "SC", southdakota: "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT", virginia: "VA", washington: "WA",
  westvirginia: "WV", wisconsin: "WI", wyoming: "WY", puertorico: "PR", guam: "GU", virginislands: "VI", americansamoa: "AS",
  northernmarianaislands: "MP",
  alberta: "AB", britishcolumbia: "BC", manitoba: "MB", newbrunswick: "NB", newfoundland: "NL", newfoundlandandlabrador: "NL",
  novascotia: "NS", ontario: "ON", princeedwardisland: "PE", quebec: "QC", saskatchewan: "SK", northwestterritories: "NT", nunavut: "NU", yukon: "YT",
};
const STATE_CODES = new Set(Object.values(STATE_NAMES));
// Common short forms people type ("Ind.", "Ill.", "Mich.").
const STATE_SHORT: Record<string, string> = { ind: "IN", ill: "IL", mich: "MI", wisc: "WI", wis: "WI", ky: "KY", penn: "PA", penna: "PA", calif: "CA", mass: "MA", minn: "MN", tenn: "TN", tex: "TX" };

export const IMPORT_FIELDS: Record<ImportEntity, ImportField[]> = {
  customers: [
    { key: "name", label: "Name", required: true, type: "text", max: 160, aliases: ["name", "customer", "customername", "custname", "company", "companyname", "account", "accountname", "businessname"] },
    { key: "customer_type", label: "Type", type: "choice", choices: CUSTOMER_TYPES, choiceLabels: CUSTOMER_TYPE_LABELS, blankMeans: "Commercial", aliases: ["type", "customertype"] },
    { key: "email", label: "Email", type: "email", max: 254, aliases: ["email", "emailaddress", "billingemail", "apemail", "invoiceemail", "accountingemail"] },
    { key: "phone", label: "Phone", type: "phone", max: 40, aliases: ["phone", "phonenumber", "telephone", "tel", "mainphone", "officephone", "phone1", "businessphone"] },
    { key: "billing_line1", label: "Billing address", type: "text", max: 200, aliases: ["address", "address1", "addressline1", "street", "streetaddress", "mailingaddress", "billingaddress", "billingaddress1", "billingstreet", "billingaddressline1"] },
    { key: "billing_line2", label: "Billing address line 2", type: "text", max: 200, aliases: ["address2", "addressline2", "billingaddress2", "billingaddressline2", "suite"] },
    { key: "billing_city", label: "City", type: "text", max: 100, aliases: ["city", "billingcity", "town"] },
    { key: "billing_state", label: "State", type: "state", aliases: ["state", "billingstate", "province", "st"] },
    { key: "billing_postal_code", label: "ZIP / postal code", type: "zip", aliases: ["zip", "zipcode", "postalcode", "postcode", "billingzip", "billingzipcode"] },
    { key: "payment_terms", label: "Payment terms", type: "text", max: 100, aliases: ["terms", "paymentterms", "netterms"] },
    { key: "po_required", label: "PO required", type: "bool", blankMeans: "No", aliases: ["porequired", "requirespo", "po", "needspo", "poreq", "ponumberrequired"] },
    { key: "tax_exempt", label: "Tax exempt", type: "bool", blankMeans: "No", aliases: ["taxexempt", "exempt", "nontaxable"] },
    { key: "notes", label: "Notes", type: "multiline", max: 2000, aliases: ["notes", "note", "comments", "memo"] },
  ],
  contacts: [
    { key: "customer_name", label: "Customer", required: true, type: "text", max: 160, aliases: ["customer", "customername", "custname", "company", "companyname", "account", "accountname", "billto"] },
    { key: "name", label: "Contact name", required: true, type: "text", max: 120, aliases: ["contactname", "contact", "name", "fullname", "contactperson", "person"] },
    { key: "name_first", label: "First name", type: "text", max: 60, partOf: "name", aliases: ["firstname", "first", "fname", "contactfirstname", "givenname"] },
    { key: "name_last", label: "Last name", type: "text", max: 60, partOf: "name", aliases: ["lastname", "last", "lname", "contactlastname", "surname", "familyname"] },
    { key: "title", label: "Title", type: "text", max: 120, aliases: ["title", "jobtitle", "role", "position", "contacttitle"] },
    { key: "email", label: "Email", type: "email", max: 254, aliases: ["email", "emailaddress", "contactemail"] },
    { key: "phone", label: "Phone", type: "phone", max: 40, aliases: ["phone", "phonenumber", "contactphone", "cell", "cellphone", "cellnumber", "mobile", "mobilenumber", "directline", "direct", "officephone"] },
    { key: "is_billing", label: "Billing contact", type: "bool", blankMeans: "No", aliases: ["billingcontact", "billing", "isbilling", "ap", "apcontact", "accountspayable", "accountspayablecontact", "sendinvoices", "invoicecontact"] },
    { key: "notes", label: "Notes", type: "multiline", max: 1000, aliases: ["notes", "note", "comments"] },
  ],
  materials: [
    { key: "name", label: "Name", required: true, type: "text", max: 120, aliases: ["name", "material", "materialname", "product", "productname", "item", "itemname"] },
    { key: "code", label: "Code", type: "code", aliases: ["code", "materialcode", "sku", "itemcode", "productcode", "itemnumber", "productnumber", "materialnumber"] },
    { key: "default_unit_code", label: "Unit", required: true, type: "choice", choices: UNITS, choiceLabels: UNIT_LABELS, aliases: ["unit", "uom", "um", "unitofmeasure", "defaultunit", "units", "per", "soldby"] },
    { key: "description", label: "Description", type: "multiline", max: 2000, aliases: ["description", "desc", "details"] },
    { key: "taxable_default", label: "Taxable", type: "bool", blankMeans: "Yes", aliases: ["taxable", "tax", "istaxable"] },
  ],
  trucks: [
    { key: "unit_number", label: "Unit number", required: true, type: "ident", max: 20, aliases: ["unit", "unitnumber", "unitno", "unitid", "truck", "trucknumber", "truckno", "truckid", "number", "fleetnumber"] },
    { key: "truck_type", label: "Truck type", required: true, type: "choice", choices: TRUCK_TYPES, choiceLabels: TRUCK_TYPE_LABELS, aliases: ["type", "trucktype", "body", "bodytype", "axles"] },
    { key: "make", label: "Make", type: "text", max: 60, aliases: ["make", "manufacturer"] },
    { key: "model", label: "Model", type: "text", max: 60, aliases: ["model"] },
    { key: "model_year", label: "Year", type: "int", aliases: ["year", "modelyear", "yr"] },
    { key: "vin", label: "VIN", type: "vin", aliases: ["vin", "vinnumber", "serial", "serialnumber"] },
    { key: "license_plate", label: "License plate", type: "ident", max: 15, aliases: ["plate", "licenseplate", "license", "tag", "platenumber", "licenseplatenumber", "tagnumber", "licensenumber"] },
    { key: "plate_state", label: "Plate state", type: "state", aliases: ["platestate", "licensestate", "tagstate", "registrationstate", "regstate", "state", "st"] },
    { key: "notes", label: "Notes", type: "multiline", max: 2000, aliases: ["notes", "note", "comments"] },
  ],
  drivers: [
    { key: "name", label: "Name", required: true, type: "text", max: 120, aliases: ["name", "driver", "drivername", "fullname", "employee", "employeename"] },
    { key: "name_first", label: "First name", type: "text", max: 60, partOf: "name", aliases: ["firstname", "first", "fname", "driverfirstname", "givenname"] },
    { key: "name_last", label: "Last name", type: "text", max: 60, partOf: "name", aliases: ["lastname", "last", "lname", "driverlastname", "surname", "familyname"] },
    { key: "employee_number", label: "Employee number", type: "ident", max: 20, aliases: ["employeenumber", "employeeno", "employeeid", "id", "number", "empno", "badge", "badgenumber", "drivernumber", "driverid"] },
    { key: "phone", label: "Phone", type: "phone", max: 40, aliases: ["phone", "phonenumber", "cell", "mobile", "cellphone", "cellnumber", "mobilenumber"] },
    { key: "hire_date", label: "Hire date", type: "date", aliases: ["hiredate", "hired", "startdate", "datehired", "dateofhire", "doh"] },
    { key: "notes", label: "Notes", type: "multiline", max: 2000, aliases: ["notes", "note", "comments"] },
    { key: "cdl_class", label: "CDL class", type: "choice", choices: CDL_CLASSES, choiceLabels: { A: "Class A", B: "Class B", C: "Class C" }, aliases: ["cdlclass", "cdl", "class", "licenseclass", "cdltype"] },
    { key: "cdl_state", label: "CDL state", type: "state", aliases: ["cdlstate", "cdlst", "licensestate", "issuingstate", "cdlissuingstate"] },
    { key: "cdl_expires_on", label: "CDL expires", type: "date", aliases: ["cdlexpires", "cdlexpiration", "cdlexp", "cdlexpiry", "licenseexpires", "licenseexpiration"] },
    { key: "cdl_endorsements", label: "CDL endorsements", type: "text", max: 60, aliases: ["endorsements", "cdlendorsements", "endorsement", "endorse"] },
    { key: "medical_expires_on", label: "Medical card expires", type: "date", aliases: ["medicalexpires", "medicalcardexpires", "medexp", "medicalexpiration", "dotmedical", "medicalcard", "medcard", "medcardexp", "medcardexpires", "medcardexpiration", "medicalexp", "dotmedicalcardexpires", "dotmedicalexpires", "dotphysical", "dotphysicalexpires", "physicalexpires", "dotcardexpires"] },
  ],
  sites: [
    { key: "customer_name", label: "Customer", required: true, type: "text", max: 160, aliases: ["customer", "customername", "custname", "company", "account", "billto"] },
    { key: "label", label: "Site name", type: "text", max: 120, blankMeans: "the street address", aliases: ["site", "sitename", "jobsite", "jobsitename", "job", "jobname", "project", "projectname", "location", "locationname", "name"] },
    { key: "line1", label: "Street address", required: true, type: "text", max: 200, aliases: ["address", "address1", "street", "streetaddress", "siteaddress", "jobaddress", "jobsiteaddress", "deliveryaddress", "projectaddress"] },
    { key: "line2", label: "Address line 2", type: "text", max: 200, aliases: ["address2", "suite", "unit"] },
    { key: "city", label: "City", type: "text", max: 100, aliases: ["city", "town"] },
    { key: "state", label: "State", type: "state", blankMeans: "IN", aliases: ["state", "st", "province"] },
    { key: "postal_code", label: "ZIP / postal code", type: "zip", aliases: ["zip", "zipcode", "postalcode", "postcode"] },
    { key: "directions", label: "Directions / access notes", type: "multiline", max: 2000, aliases: ["directions", "access", "notes", "gatecode", "instructions", "accessnotes", "deliveryinstructions"] },
  ],
  trailers: [
    { key: "unit_number", label: "Unit number", required: true, type: "ident", max: 20, aliases: ["unit", "unitnumber", "unitno", "unitid", "trailer", "trailernumber", "trailerno", "trailerid", "number"] },
    { key: "trailer_type", label: "Trailer type", required: true, type: "choice", choices: TRAILER_TYPES, choiceLabels: TRAILER_TYPE_LABELS, aliases: ["type", "trailertype", "body", "bodytype"] },
    { key: "make", label: "Make", type: "text", max: 60, aliases: ["make", "manufacturer"] },
    { key: "model", label: "Model", type: "text", max: 60, aliases: ["model"] },
    { key: "model_year", label: "Year", type: "int", aliases: ["year", "modelyear", "yr"] },
    { key: "vin", label: "VIN", type: "vin", aliases: ["vin", "vinnumber", "serial", "serialnumber"] },
    { key: "license_plate", label: "License plate", type: "ident", max: 15, aliases: ["plate", "licenseplate", "license", "tag", "platenumber", "licenseplatenumber", "tagnumber", "licensenumber"] },
    { key: "plate_state", label: "Plate state", type: "state", aliases: ["platestate", "licensestate", "tagstate", "registrationstate", "regstate", "state", "st"] },
    { key: "notes", label: "Notes", type: "multiline", max: 2000, aliases: ["notes", "note", "comments"] },
  ],
};

export const ENTITY_LABELS: Record<ImportEntity, string> = { customers: "Customers", contacts: "Customer contacts", sites: "Job sites", materials: "Materials", trucks: "Trucks", trailers: "Trailers", drivers: "Drivers" };

export const MAX_IMPORT_ROWS = 2000;
// Server actions accept bodies up to 1 MB by default; stay under it.
export const MAX_IMPORT_BYTES = 900_000;

const squash = (s: string) => s.toLowerCase().replace(/#/g, "number").replace(/[^a-z0-9]/g, "");

// Short words in column names, spelled out ("Cust Name" → customer name, "Emp No." → employee number).
const HEADER_WORDS: Record<string, string> = {
  cust: "customer", custs: "customer", acct: "account", emp: "employee", empl: "employee", no: "number", num: "number", nbr: "number",
  nmbr: "number", exp: "expires", expiry: "expires", expiration: "expires", expire: "expires", expiring: "expires", addr: "address",
  ph: "phone", tel: "phone", lic: "license", licence: "license", med: "medical", desc: "description", yr: "year",
};

/** The spellings a column name is compared with: as written, with short words spelled out, and without a trailing "date". */
function headerKeys(header: string): string[] {
  const raw = squash(header);
  const words = header.toLowerCase().replace(/#/g, " number ").split(/[^a-z0-9]+/).filter(Boolean).map((w) => HEADER_WORDS[w] ?? w);
  const spelled = words.join("");
  const keys = [raw, spelled];
  for (const k of [raw, spelled]) {
    const short = k.replace(/(date|dt)$/, "");
    if (short && short !== k) keys.push(short);
  }
  // "Gate code / Notes", "Directions & access": either name may match.
  const parts = header.split(/\s*(?:\/|&|\bor\b)\s*/i).map(squash).filter((p) => p.length > 2);
  if (parts.length > 1) keys.push(...parts);
  return [...new Set(keys)];
}

// ---------------------------------------------------------------------------------------------------------------
// Reading the file

/**
 * Text from the file's bytes, the way Excel and Google Sheets save CSV: UTF-8 (with or without a BOM), UTF-16 ("Unicode
 * text"), or Excel's older "CSV (Comma delimited)" in the Windows encoding, where é and curly quotes are not UTF-8.
 */
export function decodeSpreadsheet(bytes: ArrayBuffer | Uint8Array): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder("utf-16le").decode(b.subarray(2));
  if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder("utf-16be").decode(b.subarray(2));
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(b);
  } catch {
    return new TextDecoder("windows-1252").decode(b);
  }
}

/** Why the text cannot be a spreadsheet saved as CSV (an Excel workbook renamed, a PDF), or null when it can. */
export function notCsvProblem(text: string): string | null {
  if (text.startsWith("PK")) return "This is an Excel workbook, not a CSV file. In Excel: File → Save As → CSV UTF-8, then choose the CSV file.";
  if (text.startsWith("%PDF")) return "This is a PDF, not a spreadsheet. Export the list from the program it came from as CSV or Excel.";
  if (text.includes("\u0000")) return "This file is not a CSV text file. Save the spreadsheet as CSV UTF-8 and choose that file.";
  return null;
}

/** Split CSV (or tab/semicolon-separated text) into records, keeping blank ones so row numbers match the spreadsheet. */
function splitRecords(input: string): string[][] {
  let text = input.replace(/^﻿/, "");
  // Excel's "sep=," hint line.
  const hint = text.match(/^sep=(.)\r?\n/i);
  const firstBreak = text.search(/\r\n|\r|\n/);
  const firstLine = text.slice(0, firstBreak >= 0 ? firstBreak : text.length);
  let sep: string;
  if (hint) {
    sep = hint[1];
    text = text.slice(hint[0].length);
  } else {
    const counts = { ",": firstLine.split(",").length, "\t": firstLine.split("\t").length, ";": firstLine.split(";").length };
    sep = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
  }
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"' && field.trim() === "") {
      quoted = true;
      field = "";
    } else if (c === sep) {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const isBlankRecord = (r: string[]) => r.every((v) => cleanCell(v) === "");

/**
 * Parse CSV (or tab/semicolon-separated text pasted from a spreadsheet): quoted fields with commas, quotes ("") and
 * line breaks, CRLF or CR line ends, a leading BOM. Blank lines are dropped.
 */
export function parseCsv(input: string): string[][] {
  return splitRecords(input).filter((r) => !isBlankRecord(r));
}

export interface Sheet {
  /** The column names first, then the data rows (blank rows dropped). */
  table: string[][];
  /** The spreadsheet row number of each entry of `table` (the column names' row first). */
  rowNumbers: number[];
  /** Rows above the column names that were not read (a title such as "Customer list 2026"). */
  skipped: string[];
}

/**
 * Read a spreadsheet saved as CSV: finds the column names even below a title row, drops blank rows and keeps each
 * row's number in the spreadsheet.
 */
export function readSheet(input: string): Sheet {
  const records = splitRecords(input);
  const filled = (r: string[]) => r.filter((v) => cleanCell(v) !== "").length;
  // The column names are the first row, near the top, that fills at least half as many cells as the widest row there
  // (and at least two, unless the list has a single column).
  const top = records.slice(0, 15);
  const widest = Math.max(0, ...top.map(filled));
  // A title such as "Customer list, as of 11/3/2026" fills fewer cells than the column names do.
  const want = widest <= 1 ? widest : Math.max(2, Math.ceil(widest / 2));
  let headerAt = top.findIndex((r) => filled(r) >= want && want > 0);
  if (headerAt < 0) headerAt = records.findIndex((r) => !isBlankRecord(r));
  if (headerAt < 0) return { table: [], rowNumbers: [], skipped: [] };
  const skipped = records.slice(0, headerAt).filter((r) => !isBlankRecord(r)).map((r) => r.map(cleanCell).filter(Boolean).join(" ").slice(0, 120));
  const table: string[][] = [records[headerAt].map((h) => cleanCell(h))];
  const rowNumbers: number[] = [headerAt + 1];
  records.slice(headerAt + 1).forEach((r, i) => {
    if (isBlankRecord(r)) return;
    table.push(r);
    rowNumbers.push(headerAt + i + 2);
  });
  return { table, rowNumbers, skipped };
}

/** Header index → field key (or "" to ignore), guessed from the header names. Each field is used once. */
export function guessMapping(headers: string[], entity: ImportEntity): string[] {
  const used = new Set<string>();
  return headers.map((h) => {
    const keys = headerKeys(h);
    const f = IMPORT_FIELDS[entity].find((x) => !used.has(x.key) && keys.some((k) => squash(x.key) === k || x.aliases.includes(k)));
    if (!f) return "";
    used.add(f.key);
    return f.key;
  });
}

export function mappingProblems(mapping: string[], entity: ImportEntity): string[] {
  const out: string[] = [];
  const keys = mapping.filter(Boolean);
  for (const f of IMPORT_FIELDS[entity]) {
    if (!f.required || keys.includes(f.key)) continue;
    const parts = IMPORT_FIELDS[entity].filter((p) => p.partOf === f.key);
    if (parts.length && parts.some((p) => keys.includes(p.key))) continue;
    out.push(parts.length ? `Choose the column for "${f.label}" (or the first and last name columns).` : `Choose the column for "${f.label}".`);
  }
  const dup = keys.find((k, i) => keys.indexOf(k) !== i);
  if (dup) out.push(`Two columns are mapped to "${IMPORT_FIELDS[entity].find((f) => f.key === dup)?.label ?? dup}".`);
  const whole = IMPORT_FIELDS[entity].find((f) => keys.includes(f.key) && IMPORT_FIELDS[entity].some((p) => p.partOf === f.key && keys.includes(p.key)));
  if (whole) out.push(`Use either the "${whole.label}" column or the first and last name columns, not both.`);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Values

/** Invisible characters and non-breaking spaces (common in files copied from web pages or Excel) become spaces. */
function cleanCell(v: string): string {
  return v.replace(/[​-‍﻿]/g, "").replace(/[   ]/g, " ").trim();
}

// Cells that mean "nothing here" in any column, and also in typed columns (dates, yes/no, choices, emails, phones).
const BLANK_ALWAYS = new Set(["-", "--", "---", "–", "—", "n/a", "n.a.", "null"]);
const BLANK_TYPED = new Set(["na", "none", "tbd", "unknown", "?", "nocdl", "noncdl", "notapplicable"]);
const EXCEL_ERROR = /^#(N\/A|REF!|VALUE!|DIV\/0!|NAME\?|NUM!|NULL!|SPILL!|CALC!|GETTING_DATA)$/i;
// Excel shows long numbers such as 5551234567 or 000123 as 5.55E+09 when the column is not formatted as Text.
const SCIENTIFIC = /^\d+(\.\d+)?E\+\d+$/i;

function parseBool(v: string): boolean | null {
  const s = squash(v);
  if (["yes", "y", "true", "t", "1", "x", "required", "checked", "on"].includes(s)) return true;
  if (["no", "n", "false", "f", "0", "notrequired", "unchecked", "off"].includes(s)) return false;
  return null;
}

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7,
  aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

/**
 * A calendar date as YYYY-MM-DD, from the ways US spreadsheets show dates: 11/3/2026, 11/3/26, 11-3-2026, 2026-11-03,
 * 3-Nov-26, Nov 3, 2026, with or without a time ("11/3/2026 0:00"). Month comes before day (US order). A two-digit year
 * is in this century unless that would put it more than 30 years ahead (5/1/98 → 1998). "serial" when the cell holds an
 * Excel date number instead of a date.
 */
export function parseImportDate(value: string, today = new Date()): string | "serial" | null {
  let v = value.trim().replace(/\s+/g, " ");
  v = v.replace(/[ T]\d{1,2}:\d{2}(:\d{2}(\.\d+)?)?( ?[ap]\.?m\.?)?( ?(z|[+-]\d{2}:?\d{2}))?$/i, "").trim();
  if (/^\d{5}(\.\d+)?$/.test(v) && Number(v) >= 20000 && Number(v) <= 80000) return "serial";
  const year = (s: string) => {
    if (s.length === 4) return Number(s);
    const yy = Number(s);
    return 2000 + yy <= today.getUTCFullYear() + 30 ? 2000 + yy : 1900 + yy;
  };
  let y: number, m: number, d: number;
  let p: RegExpMatchArray | null;
  if ((p = v.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/))) [y, m, d] = [Number(p[1]), Number(p[2]), Number(p[3])];
  else if ((p = v.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/))) [m, d, y] = [Number(p[1]), Number(p[2]), year(p[3])];
  else if ((p = v.match(/^(\d{1,2})[- ]([a-z]{3,9})\.?[- ,]+(\d{2}|\d{4})$/i)) && MONTHS[p[2].toLowerCase()]) [d, m, y] = [Number(p[1]), MONTHS[p[2].toLowerCase()], year(p[3])];
  else if ((p = v.match(/^([a-z]{3,9})\.?[- ](\d{1,2})(st|nd|rd|th)?[- ,]+(\d{2}|\d{4})$/i)) && MONTHS[p[1].toLowerCase()]) [m, d, y] = [MONTHS[p[1].toLowerCase()], Number(p[2]), year(p[4])];
  else return null;
  if (y < 1900 || y > 2100) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

/** A state or province as its two-letter code ("Indiana", "ind.", "in" → "IN"), or null. */
export function stateCodeOf(value: string): string | null {
  const s = squash(value);
  if (s.length === 2 && STATE_CODES.has(s.toUpperCase())) return s.toUpperCase();
  return STATE_NAMES[s] ?? STATE_SHORT[s] ?? null;
}

function choiceValue(f: ImportField, raw: string): string | undefined {
  let s = squash(raw);
  if (f.key === "default_unit_code") s = s.replace(/^(per|by)(?=[a-z])/, "");
  if (f.key === "cdl_class") s = s.replace(/cdl|class|license/g, "");
  return f.choices?.[s] ?? f.choices?.[s.replace(/(truck|trailer)$/, "")];
}

function choiceList(f: ImportField): string {
  const labels = f.choiceLabels ? Object.values(f.choiceLabels) : [...new Set(Object.values(f.choices ?? {}))];
  return labels.join(", ");
}

/** How a stored value reads in the preview and the review: words, not codes. */
export function displayValue(entity: ImportEntity, key: string, value: string | undefined): string {
  if (value === undefined || value === "") return "";
  const f = IMPORT_FIELDS[entity].find((x) => x.key === key);
  if (!f) return value;
  if (f.type === "bool") return value === "true" ? "Yes" : value === "false" ? "No" : value;
  if (f.type === "date") return /^\d{4}-\d{2}-\d{2}$/.test(value) ? formatDate(value) : value;
  if (f.type === "choice") return f.choiceLabels?.[value] ?? value;
  return value;
}

export interface PreparedRow {
  /** Spreadsheet row number (the column names' row is 1 unless the sheet has a title above it). */
  row: number;
  data: Record<string, string>;
  errors: string[];
}

/** One cell, checked and normalized; `error` explains in plain words what to fix. */
function readValue(f: ImportField, cell: string, today: Date): { value?: string; error?: string } {
  const raw = f.type === "multiline" ? cleanCell(cell).replace(/\r\n?/g, "\n") : cleanCell(cell).replace(/\s+/g, " ");
  if (!raw) return {};
  const lower = raw.toLowerCase();
  if (EXCEL_ERROR.test(raw)) return { error: `${f.label} shows a spreadsheet error (${raw}) instead of a value. Fix that cell in the spreadsheet or clear it.` };
  if (BLANK_ALWAYS.has(lower)) return {};
  if (f.type !== "text" && f.type !== "multiline" && f.type !== "ident" && BLANK_TYPED.has(squash(raw) || lower)) return {};
  if (f.max && raw.length > f.max) return { error: `${f.label} is too long (${raw.length} characters; at most ${f.max}).` };
  switch (f.type) {
    case "email": {
      if ((raw.match(/@/g) ?? []).length > 1) return { error: `${f.label} has more than one address ("${raw}"). Keep one here and put the others in Notes.` };
      if (!/^[^@\s,;]+@[^@\s,;]+\.[^@\s,;]+$/.test(raw)) return { error: `${f.label} "${raw}" is not an email address.` };
      return { value: raw.toLowerCase() };
    }
    case "phone": {
      if (SCIENTIFIC.test(raw)) return { error: `${f.label} "${raw}" was rounded by Excel. Format the column as Text, type the number again and save.` };
      const digits = raw.replace(/\s*(?:x|ext\.?)\s*\d{0,6}\s*$/i, "").replace(/\D/g, "");
      if (/[/;&]|\band\b/i.test(raw) || (!raw.startsWith("+") && digits.length > 11)) {
        return { error: `${f.label} has more than one number ("${raw}"). Keep one here and put the other in Notes.` };
      }
      const formatted = digits.length === 10 || (digits.length === 11 && digits.startsWith("1")) || raw.startsWith("+") ? formatPhone(raw) : raw;
      if (!/^[0-9+().\-\s]{7,40}( ?(x|ext\.?) ?\d{1,6})?$/i.test(formatted)) return { error: `${f.label} "${raw}" is not a phone number.` };
      return { value: formatted };
    }
    case "bool": {
      const b = parseBool(raw);
      if (b === null) return { error: `${f.label} "${raw}" should be yes or no.` };
      return { value: String(b) };
    }
    case "int": {
      const n = Number(raw.replace(/^'/, ""));
      if (!Number.isInteger(n) || n < 1950 || n > today.getUTCFullYear() + 1) return { error: `${f.label} "${raw}" is not a year between 1950 and ${today.getUTCFullYear() + 1}.` };
      return { value: String(n) };
    }
    case "date": {
      const d = parseImportDate(raw, today);
      if (d === "serial") return { error: `${f.label} "${raw}" is an Excel date number, not a date. In Excel, format the column as a date (like 11/3/2026) and save the file again.` };
      if (!d) return { error: `${f.label} "${raw}" is not a date. Use month/day/year, like 11/3/2026.` };
      return { value: d };
    }
    case "choice": {
      const v = choiceValue(f, raw);
      if (!v) return { error: `${f.label} "${raw}" is not recognized. Use one of: ${choiceList(f)}.` };
      return { value: v };
    }
    case "state": {
      const code = stateCodeOf(raw);
      if (!code) return { error: `${f.label} "${raw}" is not a US state or Canadian province. Use the two-letter code, like IN.` };
      return { value: code };
    }
    case "zip": {
      const z = raw.toUpperCase();
      if (/^\d{4}$/.test(z)) return { error: `${f.label} "${raw}" has only 4 digits: Excel probably dropped a leading zero. Format the column as Text and type the full ZIP code.` };
      if (/^\d{9}$/.test(z)) return { value: `${z.slice(0, 5)}-${z.slice(5)}` };
      if (!/^\d{5}(-\d{4})?$/.test(z) && !/^[A-Z]\d[A-Z] ?\d[A-Z]\d$/.test(z)) return { error: `${f.label} "${raw}" is not a ZIP code (5 digits, like 46383).` };
      return { value: z };
    }
    case "vin": {
      const vin = raw.toUpperCase().replace(/[\s-]/g, "");
      if (SCIENTIFIC.test(raw) || !/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) {
        return { error: `${f.label} "${raw}" is not a full VIN: it has 17 letters and numbers, never I, O or Q. Leave it blank if you do not have the full VIN.` };
      }
      return { value: vin };
    }
    case "code": {
      if (!/^[A-Za-z0-9._-]{1,30}$/.test(raw)) return { error: `${f.label} "${raw}" can use only letters, numbers, dots, dashes and underscores (at most 30), like 57-STONE.` };
      return { value: raw };
    }
    case "ident": {
      if (SCIENTIFIC.test(raw)) return { error: `${f.label} "${raw}" was rounded by Excel. Format the column as Text, type the values again and save.` };
      return { value: raw.replace(/^'/, "") };
    }
    default:
      return { value: raw };
  }
}

/**
 * Apply the mapping and validate every row. Values are normalized (yes/no → true/false, dates → YYYY-MM-DD, types →
 * stored values, states → two-letter codes, US phone numbers → (555) 555-0142). `rowNumbers` (from readSheet) gives
 * each row its spreadsheet row number; without it the rows are numbered from 2.
 */
export function prepareRows(table: string[][], mapping: string[], entity: ImportEntity, today = new Date(), rowNumbers?: number[]): PreparedRow[] {
  const fields = Object.fromEntries(IMPORT_FIELDS[entity].map((f) => [f.key, f]));
  return table.slice(1).map((cells, i) => {
    const data: Record<string, string> = {};
    const errors: string[] = [];
    const parts: Record<string, string[]> = {};
    mapping.forEach((key, col) => {
      if (!key || !fields[key]) return;
      const f = fields[key];
      const { value, error } = readValue(f, cells[col] ?? "", today);
      if (error) errors.push(error);
      else if (value !== undefined) {
        if (f.partOf) (parts[f.partOf] ??= [])[f.key === `${f.partOf}_first` ? 0 : 1] = value;
        else data[key] = value;
      }
    });
    for (const [whole, [first, last]] of Object.entries(parts)) {
      const joined = [first, last].filter(Boolean).join(" ");
      if (joined && !data[whole]) data[whole] = joined;
    }
    for (const f of IMPORT_FIELDS[entity]) {
      if (f.required && !data[f.key] && !errors.some((e) => e.startsWith(f.label))) errors.push(`${f.label} is required.`);
    }
    // Checks that need two values of the same row.
    // (Worded as the database words them: staging drops a message the row already carries.)
    if (entity === "drivers" && !data.cdl_class && !errors.some((e) => e.startsWith("CDL class"))) {
      if (data.cdl_expires_on) errors.push("A CDL expiry needs the CDL class.");
      if (data.cdl_state) errors.push("A CDL state needs the CDL class.");
      if (data.cdl_endorsements) errors.push("CDL endorsements need the CDL class.");
    }
    if (entity === "sites" && !data.label && data.line1 && data.line1.length > 120) errors.push("Site name is needed: the street address is too long to use as the name (at most 120 characters).");
    return { row: rowNumbers?.[i + 1] ?? i + 2, data, errors };
  });
}

/** Fields the file leaves out that still get a value at approval (the preview says so). */
export function defaultsForMissing(mapping: string[], entity: ImportEntity): Array<{ label: string; value: string }> {
  return IMPORT_FIELDS[entity].filter((f) => f.blankMeans && !mapping.includes(f.key)).map((f) => ({ label: f.label, value: f.blankMeans! }));
}

/**
 * Column names for a downloadable template (Onboarding kit): each field's label when the importer recognizes it,
 * otherwise its key, so a filled template always maps back without manual mapping. First and last name columns are
 * left out (the template uses the full name).
 */
export function templateHeaders(entity: ImportEntity): string[] {
  return IMPORT_FIELDS[entity].filter((f) => !f.partOf).map((f) => (guessMapping([f.label], entity)[0] === f.key ? f.label : f.key));
}

/** The template as CSV text (header row only; no example rows that could be imported by mistake). */
export function templateCsv(entity: ImportEntity): string {
  const quote = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return `${templateHeaders(entity).map(quote).join(",")}\r\n`;
}

export interface DryRun {
  entity: ImportEntity;
  headers: string[];
  mapping: string[];
  skipped: string[];
  ignored: string[];
  problems: string[];
  defaults: Array<{ label: string; value: string }>;
  rows: PreparedRow[];
}

/**
 * The whole first check of a file, as the preview does it: read, map, validate (used by scripts/import/dry-run.ts to
 * check the owner's files before import day). Duplicates against existing records are checked by the database later.
 */
export function dryRun(text: string, entity: ImportEntity, today = new Date()): DryRun {
  const sheet = readSheet(text);
  const headers = sheet.table[0] ?? [];
  const mapping = guessMapping(headers, entity);
  return {
    entity,
    headers,
    mapping,
    skipped: sheet.skipped,
    ignored: headers.filter((h, i) => h && !mapping[i]),
    problems: mappingProblems(mapping, entity),
    defaults: defaultsForMissing(mapping, entity),
    rows: sheet.table.length > 1 ? prepareRows(sheet.table, mapping, entity, today, sheet.rowNumbers) : [],
  };
}
