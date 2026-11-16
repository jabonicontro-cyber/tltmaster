// Import dry run (LR3, docs/TOPLINE_IMPORT_PLAYBOOK.md): runs a spreadsheet saved as CSV through exactly the checks the
// import preview runs, offline, and prints what would be staged. Nothing is sent anywhere and no database is touched;
// duplicates against the company's existing records are checked later, by the database, when the file is staged.
//
//   npx tsx scripts/import/dry-run.ts <customers|contacts|sites|materials|trucks|trailers|drivers> <file.csv> [--json]

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { ENTITY_LABELS, IMPORT_ENTITIES, IMPORT_FIELDS, decodeSpreadsheet, displayValue, dryRun, notCsvProblem, type ImportEntity } from "../../src/lib/platform/imports";

const [entity, file, flag] = process.argv.slice(2);
if (!entity || !file || !(IMPORT_ENTITIES as readonly string[]).includes(entity)) {
  console.error(`Usage: npx tsx scripts/import/dry-run.ts <${IMPORT_ENTITIES.join("|")}> <file.csv> [--json]`);
  process.exit(2);
}
const text = decodeSpreadsheet(readFileSync(file));
const notCsv = notCsvProblem(text);
if (notCsv) {
  console.error(notCsv);
  process.exit(1);
}
const result = dryRun(text, entity as ImportEntity);
if (flag === "--json") {
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

const fields = IMPORT_FIELDS[result.entity];
const label = (key: string) => fields.find((f) => f.key === key)?.label ?? key;
console.log(`${ENTITY_LABELS[result.entity]} · ${basename(file)}`);
if (result.skipped.length) console.log(`Skipped above the column names: ${result.skipped.map((s) => `"${s}"`).join(", ")}`);
console.log("Columns:");
result.headers.forEach((h, i) => console.log(`  ${h || `(column ${i + 1})`} → ${result.mapping[i] ? label(result.mapping[i]) : "not imported"}`));
for (const p of result.problems) console.log(`MAPPING PROBLEM: ${p}`);
if (result.defaults.length) console.log(`Not in the file, every record gets: ${result.defaults.map((d) => `${d.label}: ${d.value}`).join(" · ")}`);
const bad = result.rows.filter((r) => r.errors.length);
console.log(`${result.rows.length} rows · ${result.rows.length - bad.length} pass the first checks · ${bad.length} need fixing`);
for (const r of result.rows) {
  const values = Object.entries(r.data).map(([k, v]) => `${label(k)}: ${displayValue(result.entity, k, v)}`).join(" | ");
  console.log(`  row ${r.row}: ${r.errors.length ? `NEEDS FIXING: ${r.errors.join(" ")}` : "OK"}${values ? `\n      ${values}` : ""}`);
}
process.exit(result.problems.length ? 1 : 0);
