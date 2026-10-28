import { z } from "zod";
import { IMPORT_ENTITIES, MAX_IMPORT_BYTES, MAX_IMPORT_ROWS, mappingProblems, parseCsv, prepareRows, type ImportEntity } from "@/lib/platform/imports";

/**
 * Reads and re-checks a spreadsheet posted by the import uploader, for the platform team's onboarding imports and a
 * company's own imports (B106). The server's own validation is authoritative; the browser preview only helps. The
 * database checks every row again when it is staged.
 */
export function readImportForm(formData: FormData):
  | { ok: true; entity: ImportEntity; fileName: string; mapping: Record<string, string>; rows: ReturnType<typeof prepareRows> }
  | { ok: false; error: string } {
  const entity = z.enum(IMPORT_ENTITIES).safeParse(formData.get("entity"));
  if (!entity.success) return { ok: false, error: "Choose what the spreadsheet contains." };
  const csv = String(formData.get("csv") ?? "");
  const fileName = String(formData.get("file_name") ?? "").slice(0, 200);
  if (!csv.trim()) return { ok: false, error: "Choose a spreadsheet file (CSV)." };
  if (csv.length > MAX_IMPORT_BYTES) return { ok: false, error: "The file is too large. Split it into smaller files." };
  let mapping: string[];
  try {
    mapping = z.array(z.string().max(40)).max(200).parse(JSON.parse(String(formData.get("mapping") ?? "[]")));
  } catch {
    return { ok: false, error: "The column choices could not be read. Choose the columns again." };
  }
  const table = parseCsv(csv);
  if (table.length < 2) return { ok: false, error: "The file has a header row but no data rows." };
  if (table.length - 1 > MAX_IMPORT_ROWS) return { ok: false, error: `Import at most ${MAX_IMPORT_ROWS.toLocaleString()} rows at a time.` };
  const problems = mappingProblems(mapping, entity.data);
  if (problems.length) return { ok: false, error: problems[0] };
  const rows = prepareRows(table, mapping, entity.data);
  const mapped = Object.fromEntries(table[0].map((h, i) => [h, mapping[i] ?? ""]).filter(([, k]) => k));
  return { ok: true, entity: entity.data, fileName, mapping: mapped, rows };
}
