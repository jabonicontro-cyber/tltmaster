"use client";

import { useMemo, useState, type ChangeEvent } from "react";
import { Badge } from "@/components/ui/badge";
import { Field, FormError, Select } from "@/components/ui/form";
import { SubmitButton } from "@/components/ui/submit-button";
import {
  ENTITY_LABELS, IMPORT_ENTITIES, IMPORT_FIELDS, MAX_IMPORT_BYTES, MAX_IMPORT_ROWS, decodeSpreadsheet, defaultsForMissing, displayValue, guessMapping,
  mappingProblems, notCsvProblem, prepareRows, readSheet, type ImportEntity,
} from "@/lib/platform/imports";
import { stageImport } from "@/app/admin/actions";

// What to import first: job sites and contacts are matched to customers that already exist.
const ENTITY_HINTS: Partial<Record<ImportEntity, string>> = {
  contacts: "Each contact is matched to a customer by name: import and approve the customers first.",
  sites: "Each job site is matched to a customer by name: import and approve the customers first.",
  drivers: "CDL and medical card dates are recorded as entered and marked unverified until someone checks them on the driver.",
};

/**
 * Choose a spreadsheet, map its columns, preview the checks, then stage it for
 * review. Nothing is created here: staging only records the rows; records are
 * created when the batch is approved. The server repeats every check.
 */
export function ImportUploader({ companyId, initial, action = stageImport }: {
  /** The company the platform team imports into; a company importing its own records leaves it out (B106). */
  companyId?: string;
  /** The server action that stages the file (the platform's by default; a company's own for self-import). */
  action?: (formData: FormData) => Promise<void>;
  /** A CSV a company uploaded to its onboarding checklist, opened by Taviron for import (still reviewed before anything is created). */
  initial?: { csv: string; fileName: string; entity: ImportEntity; documentId: string };
}) {
  const [entity, setEntity] = useState<ImportEntity>(initial?.entity ?? "customers");
  const [fileName, setFileName] = useState(initial?.fileName ?? "");
  const [csv, setCsv] = useState(initial?.csv ?? "");
  const [mapping, setMapping] = useState<string[]>(() => (initial ? guessMapping(readSheet(initial.csv).table[0] ?? [], initial.entity) : []));
  const [readError, setReadError] = useState<string | null>(null);

  const sheet = useMemo(() => readSheet(csv), [csv]);
  const headers = sheet.table[0] ?? [];
  const rows = useMemo(
    () => (sheet.table.length > 1 && mapping.length ? prepareRows(sheet.table, mapping, entity, new Date(), sheet.rowNumbers) : []),
    [sheet, mapping, entity],
  );
  const problems = csv ? mappingProblems(mapping, entity) : [];
  const withErrors = rows.filter((r) => r.errors.length).length;
  const fields = IMPORT_FIELDS[entity];
  // Preview columns: what each record gets (first and last name columns show as the joined name).
  const shown = fields.filter((f) => !f.partOf && (mapping.includes(f.key) || fields.some((p) => p.partOf === f.key && mapping.includes(p.key))));
  const ignored = headers.map((h, i) => (mapping[i] ? "" : h || `Column ${i + 1}`)).filter(Boolean);
  const defaults = defaultsForMissing(mapping, entity);

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    setReadError(null);
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > MAX_IMPORT_BYTES) {
      setReadError("The file is too large. Split it into smaller files.");
      return;
    }
    if (/\.(xlsx|xlsm|xls|numbers|ods)$/i.test(file.name)) {
      setReadError("Save the spreadsheet as CSV first (in Excel: File → Save As → CSV UTF-8), then choose the CSV file.");
      return;
    }
    const text = decodeSpreadsheet(await file.arrayBuffer());
    const notCsv = notCsvProblem(text);
    if (notCsv) {
      setReadError(notCsv);
      return;
    }
    const t = readSheet(text);
    if (t.table.length - 1 > MAX_IMPORT_ROWS) {
      setReadError(`The file has ${t.table.length - 1} rows. Import at most ${MAX_IMPORT_ROWS.toLocaleString()} at a time.`);
      return;
    }
    setFileName(file.name);
    setCsv(text);
    setMapping(guessMapping(t.table[0] ?? [], entity));
  }

  function onEntity(next: ImportEntity) {
    setEntity(next);
    if (headers.length) setMapping(guessMapping(headers, next));
  }

  return (
    <form action={action} className="space-y-5">
      {companyId ? <input type="hidden" name="company" value={companyId} /> : null}
      {initial ? <input type="hidden" name="document" value={initial.documentId} /> : null}
      <input type="hidden" name="entity" value={entity} />
      <input type="hidden" name="file_name" value={fileName} />
      <input type="hidden" name="csv" value={csv} />
      <input type="hidden" name="mapping" value={JSON.stringify(mapping)} />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="The spreadsheet contains" htmlFor="import-entity" hint={ENTITY_HINTS[entity]}>
          <Select id="import-entity" value={entity} onChange={(e) => onEntity(e.target.value as ImportEntity)}>
            {IMPORT_ENTITIES.map((e) => (
              <option key={e} value={e}>{ENTITY_LABELS[e]}</option>
            ))}
          </Select>
        </Field>
        <Field label="Spreadsheet file (CSV)" htmlFor="import-file" hint="From Excel or Google Sheets, save or download as CSV. The column names can be in any order; a title row above them is skipped.">
          <input id="import-file" type="file" accept=".csv,.tsv,.txt,text/csv" onChange={onFile} className="block w-full text-sm file:mr-3 file:rounded-xl file:border-0 file:bg-strong file:px-3 file:py-2 file:font-semibold file:text-white" />
        </Field>
      </div>
      <FormError message={readError} />

      {headers.length ? (
        <div className="space-y-3">
          <h3 className="font-bold">Match the columns</h3>
          {sheet.skipped.length ? (
            <p className="text-sm text-muted">
              Skipped {sheet.skipped.length === 1 ? "a row" : `${sheet.skipped.length} rows`} above the column names: &ldquo;{sheet.skipped.join("”, “")}&rdquo;. The column names are on row {sheet.rowNumbers[0]}.
            </p>
          ) : null}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {headers.map((h, i) => (
              <label key={i} className="block text-sm">
                <span className="font-semibold">{h || `Column ${i + 1}`}</span>
                <Select
                  aria-label={`Field for column ${h || i + 1}`}
                  value={mapping[i] ?? ""}
                  onChange={(e) => setMapping((m) => m.map((v, j) => (j === i ? e.target.value : v)))}
                  className="mt-1"
                >
                  <option value="">Do not import</option>
                  {fields.map((f) => (
                    <option key={f.key} value={f.key}>
                      {f.label}
                      {f.required ? " (required)" : ""}
                    </option>
                  ))}
                </Select>
              </label>
            ))}
          </div>
          {ignored.length ? <p className="text-sm text-muted">Not imported: {ignored.join(", ")}.</p> : null}
          {problems.map((p) => (
            <FormError key={p} message={p} />
          ))}
          {!problems.length && rows.length ? (
            <>
              <p className="text-sm">
                <strong>{rows.length}</strong> rows · <strong>{rows.length - withErrors}</strong> pass the first checks · <strong>{withErrors}</strong> need fixing.
                Row numbers are the rows in your spreadsheet. Duplicates are checked against the company&apos;s records on the next step.
              </p>
              {defaults.length ? (
                <p className="text-sm text-muted">
                  Not in this file, so every record gets: {defaults.map((d) => `${d.label}: ${d.value}`).join(" · ")}.
                </p>
              ) : null}
              <div className="max-h-80 overflow-auto rounded-control border border-line bg-card">
                <table className="w-full text-sm" aria-label="Preview">
                  <thead className="sticky top-0 bg-surface">
                    <tr>
                      <th className="px-2 py-1.5 text-left">Row</th>
                      {/* Checks first: on a wide file the problems stay in view without scrolling sideways. */}
                      <th className="min-w-56 px-2 py-1.5 text-left">Checks</th>
                      {shown.map((f) => (
                        <th key={f.key} className="px-2 py-1.5 text-left">{f.label}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.slice(0, 50).map((r) => (
                      <tr key={r.row} className="border-t border-line align-top">
                        <td className="px-2 py-1.5 text-muted tabular">{r.row}</td>
                        <td className="px-2 py-1.5">
                          {r.errors.length ? (
                            <>
                              <Badge tone="red">Needs fixing</Badge>
                              <p className="mt-1 text-xs">{r.errors.join(" ")}</p>
                            </>
                          ) : (
                            <Badge tone="green">OK</Badge>
                          )}
                        </td>
                        {shown.map((f) => (
                          <td key={f.key} className="px-2 py-1.5">
                            {r.data[f.key] ? displayValue(entity, f.key, r.data[f.key]) : f.blankMeans ? <span className="text-muted" title="Blank in the file: this value is used">{f.blankMeans}</span> : ""}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {rows.length > 50 ? <p className="text-xs text-muted">Showing the first 50 rows. All rows are checked, and the next step shows every row.</p> : null}
              <SubmitButton pendingLabel="Checking…">Check and send to review</SubmitButton>
              <p className="text-xs text-muted">Nothing is created yet: the next step shows every row, and the records are created only when someone approves.</p>
            </>
          ) : null}
        </div>
      ) : null}
    </form>
  );
}
