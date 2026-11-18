import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { EXPORT_SHEETS, FILES_PER_PART, csvLine, csvRows, exportFolder, extensionOf, readme, safeName } from "@/lib/data-export";
import { ZIP_LIMIT, ZipWriter } from "./zip";

// "Download all your data" (owner 2026-11-17; master plan §12 EX1). The zips are produced while they download: each
// spreadsheet is read 1000 rows at a time and each file one at a time, so memory stays small whatever the company's
// size. Every read goes through the database's data_export_* functions with the owner's own session: they answer only
// for the owner of the current company, two-step verified, never a support visit, and only with that company's rows
// (migration 20261120024500). Order documents have no storage rule for people, so their bytes are fetched with the
// service key, but only for paths the database just listed for this company and that sit in its own folder.

type Db = SupabaseClient;
type Page = { columns: string[]; rows: Array<Record<string, unknown> & { id: string }> };
type ExportFile = { id: string; bucket: "ticket-photos" | "order-documents"; path: string; mime: string | null; label: string; kind: string; created_at: string };

export type ExportSummary = { counts: Record<string, number>; files: number };

/** Counts for the page, or why they cannot be read ("missing": update not installed; "refused": not allowed now). */
export async function exportSummary(db: Db): Promise<{ ok: true; data: ExportSummary } | { ok: false; reason: "missing" | "refused"; message: string }> {
  const { data, error } = await db.rpc("data_export_summary");
  if (error) {
    if (error.code === "PGRST202" || error.code === "42883") return { ok: false, reason: "missing", message: "" };
    return { ok: false, reason: "refused", message: error.code === "42501" ? error.message : "Your data cannot be read right now. Try again in a minute." };
  }
  return { ok: true, data: data as ExportSummary };
}

/** Every row of one table, page by page, as CSV text (header first). A page that cannot be read ends the sheet early. */
async function* sheet(db: Db, table: string, problems: string[], label: string): AsyncGenerator<string> {
  let after: string | null = null;
  let header = false;
  for (let page = 0; page < 10_000; page++) {
    const { data, error } = await db.rpc("data_export_rows", { p_table: table, p_after: after });
    if (error) {
      problems.push(`${label}: could not be read completely (${error.code === "42501" ? error.message : "try again later"}).`);
      return;
    }
    const p = data as Page;
    if (!header) {
      yield csvLine(p.columns);
      header = true;
    }
    if (!p.rows.length) return;
    yield csvRows(p.columns, p.rows);
    after = p.rows[p.rows.length - 1].id;
    if (p.rows.length < 1000) return;
  }
}

async function* once(text: string): AsyncGenerator<string> {
  yield text;
}

/** The spreadsheets zip: README, one CSV per kind of record, and NOT-COMPLETE.txt when anything could not be read. */
export async function* spreadsheetsZip(db: Db, company: string, day: string, counts: Record<string, number> | null): AsyncGenerator<Uint8Array> {
  const zip = new ZipWriter();
  const folder = exportFolder(company, day);
  const problems: string[] = [];
  yield* zip.deflated(`${folder}/README.txt`, once(readme(company, day, counts)));
  for (const s of EXPORT_SHEETS) yield* zip.deflated(`${folder}/${s.file}`, sheet(db, s.table, problems, s.file));
  if (problems.length) yield* zip.deflated(`${folder}/NOT-COMPLETE.txt`, once(["Some records could not be read; download again to get them:", ...problems, ""].join("\r\n")));
  yield* zip.finish();
}

/** Part `n` (from 1) of the photos and documents, with files.csv listing what each file is (and any that are missing). */
export async function* filesZip(db: Db, admin: Db | null, companyId: string, company: string, day: string, n: number): AsyncGenerator<Uint8Array> {
  const zip = new ZipWriter();
  const folder = `${exportFolder(company, day)}-files-${n}`;
  const { data, error } = await db.rpc("data_export_files", { p_offset: (n - 1) * FILES_PER_PART, p_limit: FILES_PER_PART });
  const files = error ? [] : ((data ?? []) as ExportFile[]);
  let index = csvLine(["File", "What it is", "Record id", "Ticket or file name", "Saved", "Status"]);
  if (error) index += csvLine(["", "", "", "", "", "The list of files could not be read. Try again later."]);
  for (const f of files) {
    const ext = extensionOf(f.path);
    const sub = f.bucket === "ticket-photos" ? "ticket-photos" : "order-documents";
    const base = f.bucket === "ticket-photos" ? `ticket-${safeName(f.label, "no-ticket")}` : safeName(f.label.replace(/\.[A-Za-z0-9]{1,5}$/, ""), "document");
    const name = `${sub}/${base}-${f.id.slice(0, 8)}${ext}`;
    const what = f.bucket === "ticket-photos" ? `Ticket ${f.kind === "scan" ? "scan" : "photo"}` : `Order document (${f.kind.replace(/_/g, " ")})`;
    // Only this company's own folder, and only files the database listed for it.
    const bytes = f.path.startsWith(`${companyId}/`) ? await download(f.bucket === "ticket-photos" ? db : admin, f) : null;
    if (!bytes) {
      index += csvLine([name, what, f.id, f.label, f.created_at, "Missing: the stored file could not be opened"]);
      continue;
    }
    if (zip.size + bytes.length > ZIP_LIMIT) {
      index += csvLine([name, what, f.id, f.label, f.created_at, "Not in this download: it is too large. Ask Taviron support for this file."]);
      continue;
    }
    yield* zip.stored(`${folder}/${name}`, bytes, new Date(f.created_at));
    index += csvLine([name, what, f.id, f.label, f.created_at, "Included"]);
  }
  yield* zip.deflated(`${folder}/files.csv`, once(index));
  yield* zip.finish();
}

async function download(client: Db | null, f: ExportFile): Promise<Uint8Array | null> {
  if (!client) return null;
  const { data, error } = await client.storage.from(f.bucket).download(f.path);
  if (error || !data) return null;
  return new Uint8Array(await data.arrayBuffer());
}
