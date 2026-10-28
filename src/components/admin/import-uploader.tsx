"use client";

import { useMemo, useState, type ChangeEvent } from "react";
import { Field, FormError, Select } from "@/components/ui/form";
import { SubmitButton } from "@/components/ui/submit-button";
import { ENTITY_LABELS, IMPORT_ENTITIES, IMPORT_FIELDS, MAX_IMPORT_BYTES, MAX_IMPORT_ROWS, guessMapping, mappingProblems, parseCsv, prepareRows, type ImportEntity } from "@/lib/platform/imports";
import { stageImport } from "@/app/admin/actions";

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
  const [mapping, setMapping] = useState<string[]>(() => (initial ? guessMapping(parseCsv(initial.csv)[0] ?? [], initial.entity) : []));
  const [readError, setReadError] = useState<string | null>(null);

  const table = useMemo(() => (csv ? parseCsv(csv) : []), [csv]);
  const headers = table[0] ?? [];
  const rows = useMemo(() => (table.length > 1 && mapping.length ? prepareRows(table, mapping, entity) : []), [table, mapping, entity]);
  const problems = csv ? mappingProblems(mapping, entity) : [];
  const withErrors = rows.filter((r) => r.errors.length).length;

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    setReadError(null);
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > MAX_IMPORT_BYTES) {
      setReadError("The file is too large. Split it into smaller files.");
      return;
    }
    if (/\.(xlsx|xls|numbers|ods)$/i.test(file.name)) {
      setReadError("Save the spreadsheet as CSV first (in Excel: File → Save As → CSV UTF-8), then choose the CSV file.");
      return;
    }
    const text = await file.text();
    const t = parseCsv(text);
    if (t.length - 1 > MAX_IMPORT_ROWS) {
      setReadError(`The file has ${t.length - 1} rows. Import at most ${MAX_IMPORT_ROWS.toLocaleString()} at a time.`);
      return;
    }
    setFileName(file.name);
    setCsv(text);
    setMapping(guessMapping(t[0] ?? [], entity));
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
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="The spreadsheet contains" htmlFor="import-entity">
          <Select id="import-entity" value={entity} onChange={(e) => onEntity(e.target.value as ImportEntity)}>
            {IMPORT_ENTITIES.map((e) => (
              <option key={e} value={e}>{ENTITY_LABELS[e]}</option>
            ))}
          </Select>
        </Field>
        <Field label="Spreadsheet file (CSV)" htmlFor="import-file" hint="From Excel or Google Sheets, save or download as CSV. The first row must be the column names.">
          <input id="import-file" type="file" accept=".csv,.tsv,.txt,text/csv" onChange={onFile} className="block w-full text-sm file:mr-3 file:rounded-xl file:border-0 file:bg-strong file:px-3 file:py-2 file:font-semibold file:text-white" />
        </Field>
      </div>
      <FormError message={readError} />

      {headers.length ? (
        <div className="space-y-3">
          <h3 className="font-bold">Match the columns</h3>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
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
                  {IMPORT_FIELDS[entity].map((f) => (
                    <option key={f.key} value={f.key}>
                      {f.label}
                      {f.required ? " (required)" : ""}
                    </option>
                  ))}
                </Select>
              </label>
            ))}
          </div>
          {problems.map((p) => (
            <FormError key={p} message={p} />
          ))}
          {!problems.length && rows.length ? (
            <>
              <p className="text-sm">
                <strong>{rows.length}</strong> rows · <strong>{rows.length - withErrors}</strong> pass the first checks · <strong className={withErrors ? "text-red-700" : undefined}>{withErrors}</strong> need fixing.
                Duplicates are checked against the company&apos;s records on the next step.
              </p>
              <div className="max-h-80 overflow-auto rounded-control border border-line bg-card">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-surface">
                    <tr>
                      <th className="px-2 py-1.5 text-left">Row</th>
                      {IMPORT_FIELDS[entity].filter((f) => mapping.includes(f.key)).map((f) => (
                        <th key={f.key} className="px-2 py-1.5 text-left">{f.label}</th>
                      ))}
                      <th className="px-2 py-1.5 text-left">Checks</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.slice(0, 50).map((r) => (
                      <tr key={r.row} className="border-t border-line">
                        <td className="px-2 py-1.5 text-muted">{r.row}</td>
                        {IMPORT_FIELDS[entity].filter((f) => mapping.includes(f.key)).map((f) => (
                          <td key={f.key} className="px-2 py-1.5">{r.data[f.key] ?? ""}</td>
                        ))}
                        <td className={r.errors.length ? "px-2 py-1.5 text-red-700" : "px-2 py-1.5 text-green-700"}>{r.errors.length ? r.errors.join(" ") : "OK"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {rows.length > 50 ? <p className="text-xs text-muted">Showing the first 50 rows. All rows are checked.</p> : null}
              <SubmitButton pendingLabel="Checking…">Check and send to review</SubmitButton>
            </>
          ) : null}
        </div>
      ) : null}
    </form>
  );
}
