import { csvCell } from "@/lib/portal-tickets";

// "Download all your data" (owner 2026-11-17, master plan §12 EX1): what the owner's zip holds and how each part is
// written. Pure helpers; the server streams the zip (src/server/data-export/) and the database decides who may read it
// (public.data_export_*, migration 20261120024500: the company's owner, two-step verified, never a support visit).

/** One spreadsheet per table, in this order. The table names are the database's (the only ones it lets the export read). */
export const EXPORT_SHEETS: ReadonlyArray<{ table: string; file: string; label: string }> = [
  { table: "customers", file: "customers.csv", label: "Customers" },
  { table: "customer_contacts", file: "customer-contacts.csv", label: "Customer contacts" },
  { table: "customer_sites", file: "job-sites.csv", label: "Job sites" },
  { table: "materials", file: "materials.csv", label: "Materials" },
  { table: "charge_items", file: "charge-items.csv", label: "Services and charges" },
  { table: "price_lists", file: "price-lists.csv", label: "Price lists" },
  { table: "price_list_entries", file: "price-list-prices.csv", label: "Price list prices" },
  { table: "quotes", file: "quotes.csv", label: "Quotes" },
  { table: "quote_lines", file: "quote-lines.csv", label: "Quote lines" },
  { table: "orders", file: "orders.csv", label: "Orders" },
  { table: "order_lines", file: "order-lines.csv", label: "Order lines" },
  { table: "order_stops", file: "order-stops.csv", label: "Order stops" },
  { table: "order_loads", file: "loads.csv", label: "Loads" },
  { table: "dispatch_assignments", file: "load-assignments.csv", label: "Load assignments (truck and driver)" },
  { table: "delivery_tickets", file: "delivery-tickets.csv", label: "Delivery tickets" },
  { table: "ticket_attachments", file: "ticket-photos.csv", label: "Ticket photos (list)" },
  { table: "order_documents", file: "order-documents.csv", label: "Order documents (list)" },
  { table: "invoices", file: "invoices.csv", label: "Invoices" },
  { table: "invoice_orders", file: "invoice-orders.csv", label: "Orders on each invoice" },
  { table: "invoice_payments", file: "invoice-payments.csv", label: "Invoice payments" },
  { table: "customer_payments", file: "customer-payments.csv", label: "Customer payments (paid against tickets)" },
  { table: "ticket_payment_applications", file: "payments-by-ticket.csv", label: "Payments applied to tickets" },
  { table: "trucks", file: "trucks.csv", label: "Trucks" },
  { table: "trailers", file: "trailers.csv", label: "Trailers" },
  { table: "drivers", file: "drivers.csv", label: "Drivers" },
  { table: "driver_qualifications", file: "driver-qualifications.csv", label: "Driver licenses and cards" },
  { table: "haulers", file: "hired-trucks.csv", label: "Hired trucking companies" },
  { table: "employees", file: "people.csv", label: "People" },
  { table: "company_memberships", file: "sign-ins.csv", label: "Sign-ins and roles" },
  { table: "work_orders", file: "work-orders.csv", label: "Work orders" },
  { table: "work_order_tasks", file: "work-order-tasks.csv", label: "Work order tasks" },
  { table: "fuel_purchases", file: "fuel.csv", label: "Fuel purchases" },
  { table: "time_off_requests", file: "time-off.csv", label: "Time off requests" },
  { table: "pto_ledger", file: "time-off-balances.csv", label: "Time off balance changes" },
];

/** Photos and documents per download, so a big company gets several smaller zips instead of one that times out. */
export const FILES_PER_PART = 200;

export const filesParts = (files: number) => Math.max(0, Math.ceil(files / FILES_PER_PART));

/** The part a request names: "spreadsheets", or "files-N" (N from 1). Anything else is refused. */
export function parsePart(raw: string | null): { kind: "spreadsheets" } | { kind: "files"; n: number } | null {
  if (raw === "spreadsheets") return { kind: "spreadsheets" };
  const m = /^files-([1-9]\d{0,3})$/.exec(raw ?? "");
  return m ? { kind: "files", n: Number(m[1]) } : null;
}

/** One value as a spreadsheet cell: lists and details as JSON text; formulas neutralised (csvCell). */
export function exportCell(value: unknown): string {
  if (value !== null && typeof value === "object") return csvCell(JSON.stringify(value));
  return csvCell(value);
}

/** A CSV line (CRLF, as spreadsheets expect). */
export const csvLine = (cells: readonly unknown[]) => cells.map(exportCell).join(",") + "\r\n";

/** Rows as CSV lines in the column order given (a column missing from a row is an empty cell). */
export function csvRows(columns: readonly string[], rows: ReadonlyArray<Record<string, unknown>>): string {
  let out = "";
  for (const r of rows) out += csvLine(columns.map((c) => r[c]));
  return out;
}

/** A name safe inside a zip: letters, digits, dot, dash and underscore only, no folders, never empty. */
export function safeName(raw: string, fallback = "file"): string {
  const s = raw.normalize("NFKD").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/\.{2,}/g, ".").replace(/^[-.]+|[-.]+$/g, "").slice(0, 60);
  return s || fallback;
}

/** The file extension of a stored object's path (".jpg", ".pdf"), or "" when it has none we recognise. */
export function extensionOf(path: string): string {
  const m = /\.([A-Za-z0-9]{1,5})$/.exec(path);
  return m ? `.${m[1].toLowerCase()}` : "";
}

/** The zip's folder name: the company and the day, e.g. "northfield-aggregates-data-2026-11-17". */
export function exportFolder(company: string, day: string): string {
  return `${safeName(company.toLowerCase(), "company")}-data-${day}`;
}

export function readme(company: string, day: string, counts: Record<string, number> | null): string {
  const lines = [
    `${company}: all your data, downloaded ${day}`,
    "",
    "Each spreadsheet (.csv) holds one kind of record; open it with Excel, Numbers or Google Sheets.",
    "Every record has an id. Columns ending in _id point at a record in another spreadsheet, for example",
    "orders.csv customer_id is the id of a row in customers.csv.",
    "Columns ending in _cents are money in cents: divide by 100 for dollars. Times are in UTC.",
    "Ticket photos and order documents are in separate downloads (Settings, Download your data).",
    "",
    "Spreadsheets:",
    ...EXPORT_SHEETS.map((s) => `  ${s.file.padEnd(28)} ${s.label}${counts && s.table in counts ? ` (${counts[s.table]})` : ""}`),
    "",
  ];
  return lines.join("\r\n");
}
