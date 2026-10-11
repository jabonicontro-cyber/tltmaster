// Team-led onboarding imports: spreadsheet (CSV) parsing, column mapping and
// row validation. The same code runs in the browser (preview while mapping)
// and on the server (the authoritative check before staging); the database
// checks required fields, allowed values and duplicates once more.

export const IMPORT_ENTITIES = ["customers", "materials", "trucks", "drivers"] as const;
export type ImportEntity = (typeof IMPORT_ENTITIES)[number];

type FieldType = "text" | "email" | "bool" | "int" | "date" | "choice";

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
}

const TRUCK_TYPES: Record<string, string> = {
  singleaxle: "single_axle_dump", singleaxledump: "single_axle_dump", single: "single_axle_dump",
  tandem: "tandem_axle_dump", tandemaxle: "tandem_axle_dump", tandemaxledump: "tandem_axle_dump", tandemdump: "tandem_axle_dump",
  triaxle: "tri_axle_dump", triaxledump: "tri_axle_dump", tri: "tri_axle_dump", tridump: "tri_axle_dump",
  quadaxle: "quad_axle_dump", quadaxledump: "quad_axle_dump", quad: "quad_axle_dump",
  tractor: "tractor", semi: "tractor", other: "other",
};
const UNITS: Record<string, string> = {
  ton: "ton", tons: "ton", t: "ton", tn: "ton",
  load: "load", loads: "load", ld: "load",
  cuyd: "cu_yd", cuyds: "cu_yd", cy: "cu_yd", yd: "cu_yd", yard: "cu_yd", yards: "cu_yd", cubicyard: "cu_yd", cubicyards: "cu_yd",
  hour: "hour", hours: "hour", hr: "hour", hrs: "hour",
  mile: "mile", miles: "mile", mi: "mile",
  day: "day", days: "day",
  each: "each", ea: "each",
};
const CUSTOMER_TYPES: Record<string, string> = {
  commercial: "commercial", business: "commercial", company: "commercial", contractor: "commercial",
  residential: "residential", homeowner: "residential", individual: "residential", private: "residential",
};

export const IMPORT_FIELDS: Record<ImportEntity, ImportField[]> = {
  customers: [
    { key: "name", label: "Name", required: true, type: "text", max: 200, aliases: ["name", "customer", "customername", "company", "companyname", "account", "accountname"] },
    { key: "customer_type", label: "Type", type: "choice", choices: CUSTOMER_TYPES, aliases: ["type", "customertype"] },
    { key: "email", label: "Email", type: "email", max: 254, aliases: ["email", "emailaddress", "billingemail"] },
    { key: "phone", label: "Phone", type: "text", max: 40, aliases: ["phone", "phonenumber", "telephone", "tel", "mainphone"] },
    { key: "billing_line1", label: "Billing address", type: "text", max: 200, aliases: ["address", "address1", "addressline1", "street", "billingaddress", "billingaddress1", "billingstreet"] },
    { key: "billing_line2", label: "Billing address line 2", type: "text", max: 200, aliases: ["address2", "addressline2", "billingaddress2", "suite"] },
    { key: "billing_city", label: "City", type: "text", max: 100, aliases: ["city", "billingcity", "town"] },
    { key: "billing_state", label: "State", type: "text", max: 40, aliases: ["state", "billingstate", "province", "st"] },
    { key: "billing_postal_code", label: "ZIP / postal code", type: "text", max: 20, aliases: ["zip", "zipcode", "postalcode", "postcode", "billingzip"] },
    { key: "payment_terms", label: "Payment terms", type: "text", max: 100, aliases: ["terms", "paymentterms"] },
    { key: "po_required", label: "PO required", type: "bool", aliases: ["porequired", "requirespo", "po", "needspo"] },
    { key: "tax_exempt", label: "Tax exempt", type: "bool", aliases: ["taxexempt", "exempt", "nontaxable"] },
    { key: "notes", label: "Notes", type: "text", max: 2000, aliases: ["notes", "note", "comments", "memo"] },
  ],
  materials: [
    { key: "name", label: "Name", required: true, type: "text", max: 200, aliases: ["name", "material", "materialname", "product", "item", "itemname"] },
    { key: "code", label: "Code", type: "text", max: 40, aliases: ["code", "materialcode", "sku", "itemcode", "productcode"] },
    { key: "default_unit_code", label: "Unit", required: true, type: "choice", choices: UNITS, aliases: ["unit", "uom", "unitofmeasure", "defaultunit", "units"] },
    { key: "description", label: "Description", type: "text", max: 2000, aliases: ["description", "desc", "details"] },
    { key: "taxable_default", label: "Taxable", type: "bool", aliases: ["taxable", "tax", "istaxable"] },
  ],
  trucks: [
    { key: "unit_number", label: "Unit number", required: true, type: "text", max: 40, aliases: ["unit", "unitnumber", "unitno", "truck", "trucknumber", "truckno", "number", "fleetnumber"] },
    { key: "truck_type", label: "Truck type", required: true, type: "choice", choices: TRUCK_TYPES, aliases: ["type", "trucktype", "body", "bodytype", "axles"] },
    { key: "make", label: "Make", type: "text", max: 60, aliases: ["make", "manufacturer"] },
    { key: "model", label: "Model", type: "text", max: 60, aliases: ["model"] },
    { key: "model_year", label: "Year", type: "int", aliases: ["year", "modelyear", "yr"] },
    { key: "vin", label: "VIN", type: "text", max: 17, aliases: ["vin", "vinnumber", "serial"] },
    { key: "license_plate", label: "License plate", type: "text", max: 20, aliases: ["plate", "licenseplate", "license", "tag", "platenumber"] },
    { key: "plate_state", label: "Plate state", type: "text", max: 20, aliases: ["platestate", "licensestate", "tagstate"] },
    { key: "notes", label: "Notes", type: "text", max: 2000, aliases: ["notes", "note", "comments"] },
  ],
  drivers: [
    { key: "name", label: "Name", required: true, type: "text", max: 120, aliases: ["name", "driver", "drivername", "fullname", "employee", "employeename"] },
    { key: "employee_number", label: "Employee number", type: "text", max: 40, aliases: ["employeenumber", "employeeno", "employeeid", "id", "number", "empno", "badge"] },
    { key: "phone", label: "Phone", type: "text", max: 40, aliases: ["phone", "phonenumber", "cell", "mobile", "cellphone"] },
    { key: "hire_date", label: "Hire date", type: "date", aliases: ["hiredate", "hired", "startdate", "datehired"] },
    { key: "notes", label: "Notes", type: "text", max: 2000, aliases: ["notes", "note", "comments"] },
  ],
};

export const ENTITY_LABELS: Record<ImportEntity, string> = { customers: "Customers", materials: "Materials", trucks: "Trucks", drivers: "Drivers" };

export const MAX_IMPORT_ROWS = 2000;
// Server actions accept bodies up to 1 MB by default; stay under it.
export const MAX_IMPORT_BYTES = 900_000;

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Parse CSV (or tab/semicolon-separated text pasted from a spreadsheet):
 * quoted fields with commas, quotes ("") and line breaks, CRLF, a leading BOM.
 * Blank lines are dropped.
 */
export function parseCsv(input: string): string[][] {
  const text = input.replace(/^﻿/, "");
  const firstLine = text.slice(0, text.search(/\r?\n/) >= 0 ? text.search(/\r?\n/) : text.length);
  const counts = { ",": firstLine.split(",").length, "\t": firstLine.split("\t").length, ";": firstLine.split(";").length };
  const sep = (Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0]) as "," | "\t" | ";";
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
    } else if (c === '"' && field === "") quoted = true;
    else if (c === sep) {
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
  return rows.filter((r) => r.some((v) => v.trim() !== ""));
}

/** Header index → field key (or "" to ignore), guessed from the header names. Each field is used once. */
export function guessMapping(headers: string[], entity: ImportEntity): string[] {
  const used = new Set<string>();
  return headers.map((h) => {
    const k = squash(h);
    const f = IMPORT_FIELDS[entity].find((x) => !used.has(x.key) && (squash(x.key) === k || x.aliases.includes(k)));
    if (!f) return "";
    used.add(f.key);
    return f.key;
  });
}

export function mappingProblems(mapping: string[], entity: ImportEntity): string[] {
  const out: string[] = [];
  const keys = mapping.filter(Boolean);
  for (const f of IMPORT_FIELDS[entity]) {
    if (f.required && !keys.includes(f.key)) out.push(`Choose the column for "${f.label}".`);
  }
  const dup = keys.find((k, i) => keys.indexOf(k) !== i);
  if (dup) out.push(`Two columns are mapped to "${IMPORT_FIELDS[entity].find((f) => f.key === dup)?.label ?? dup}".`);
  return out;
}

function parseBool(v: string): boolean | null {
  const s = squash(v);
  if (["yes", "y", "true", "t", "1", "x"].includes(s)) return true;
  if (["no", "n", "false", "f", "0"].includes(s)) return false;
  return null;
}

function parseDate(v: string): string | null {
  let y: number, m: number, d: number;
  const iso = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  const us = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (iso) [y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  else if (us) [m, d, y] = [Number(us[1]), Number(us[2]), Number(us[3].length === 2 ? `20${us[3]}` : us[3])];
  else return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

export interface PreparedRow {
  /** Spreadsheet row number (the header is row 1). */
  row: number;
  data: Record<string, string>;
  errors: string[];
}

/** Apply the mapping and validate every row. Values are normalized (yes/no → true/false, dates → YYYY-MM-DD, types → stored values). */
export function prepareRows(table: string[][], mapping: string[], entity: ImportEntity, today = new Date()): PreparedRow[] {
  const fields = Object.fromEntries(IMPORT_FIELDS[entity].map((f) => [f.key, f]));
  return table.slice(1).map((cells, i) => {
    const data: Record<string, string> = {};
    const errors: string[] = [];
    mapping.forEach((key, col) => {
      if (!key) return;
      const f = fields[key];
      const raw = (cells[col] ?? "").trim();
      if (!raw) return;
      if (f.max && raw.length > f.max) {
        errors.push(`${f.label} is longer than ${f.max} characters.`);
        return;
      }
      switch (f.type) {
        case "email":
          if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(raw)) errors.push(`${f.label} "${raw}" is not a valid email address.`);
          else data[key] = raw.toLowerCase();
          break;
        case "bool": {
          const b = parseBool(raw);
          if (b === null) errors.push(`${f.label} "${raw}" should be yes or no.`);
          else data[key] = String(b);
          break;
        }
        case "int": {
          const n = Number(raw);
          if (!Number.isInteger(n) || (key === "model_year" && (n < 1950 || n > today.getUTCFullYear() + 1))) errors.push(`${f.label} "${raw}" is not a valid year.`);
          else data[key] = String(n);
          break;
        }
        case "date": {
          const d = parseDate(raw);
          if (!d) errors.push(`${f.label} "${raw}" is not a date (use YYYY-MM-DD or MM/DD/YYYY).`);
          else data[key] = d;
          break;
        }
        case "choice": {
          const v = f.choices?.[squash(raw)];
          if (!v) errors.push(`${f.label} "${raw}" is not recognized.`);
          else data[key] = v;
          break;
        }
        default:
          data[key] = raw;
      }
    });
    for (const f of IMPORT_FIELDS[entity]) {
      if (f.required && !data[f.key] && !errors.some((e) => e.startsWith(f.label))) errors.push(`${f.label} is required.`);
    }
    return { row: i + 2, data, errors };
  });
}
