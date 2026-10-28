import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Notice } from "@/components/ui/states";
import { SubmitButton } from "@/components/ui/submit-button";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { ENTITY_LABELS, IMPORT_FIELDS } from "@/lib/platform/imports";
import type { ImportBatch, ImportRow } from "@/lib/platform/types";

// The review of a staged spreadsheet, shared by the platform team's onboarding imports and a company's own imports
// (B106): one table, one set of row decisions, approve or discard. The caller passes its own actions and what follows
// an approved batch (revert for the platform, undo for a company).

const ROW_STATUS: Record<ImportRow["status"], { label: string; tone: "green" | "amber" | "red" }> = {
  valid: { label: "Ready", tone: "green" },
  duplicate: { label: "Possible duplicate", tone: "amber" },
  error: { label: "Needs fixing", tone: "red" },
};
const OUTCOME: Record<string, string> = {
  created: "Created",
  removed: "Removed by revert",
  kept_changed: "Kept (changed since import) — deactivated",
  kept_in_use: "Kept (in use) — deactivated",
  deactivated: "Made inactive by undo",
};

type Action = (formData: FormData) => Promise<void>;

export function ImportReview({ batch, companyName, actions, afterApproved }: {
  batch: ImportBatch;
  companyName: string;
  actions: { decide: Action; approve: Action; discard: Action };
  /** Shown once the batch is approved (revert or undo). */
  afterApproved?: ReactNode;
}) {
  const fields = IMPORT_FIELDS[batch.entity].filter((f) => batch.rows.some((r) => r.data[f.key]));
  const toImport = batch.rows.filter((r) => r.decision === "import").length;
  const review = batch.status === "review";
  return (
    <>
      {review ? (
        <Notice title="Nothing has been created yet">
          Check each row. Rows that need fixing are never imported: correct them in the spreadsheet and import them again. A possible duplicate is skipped unless you choose to
          import it (only where the records allow two of the same). Approving creates the {toImport} rows marked &ldquo;Import&rdquo;, all at once or not at all.
        </Notice>
      ) : null}
      {(batch.status === "reverted" || batch.status === "deactivated") && batch.revert_reason ? <Notice title={batch.status === "reverted" ? "Reverted" : "Undone"}>{batch.revert_reason}</Notice> : null}

      <div className="mt-5">
        <TableWrap>
          <Table aria-label="Rows">
            <thead>
              <tr>
                <Th>Row</Th>
                {fields.map((f) => <Th key={f.key}>{f.label}</Th>)}
                <Th>Checks</Th>
                <Th>{review ? "Decision" : "Result"}</Th>
              </tr>
            </thead>
            <tbody>
              {batch.rows.map((r) => (
                <Tr key={r.id} id={`row-${r.id}`}>
                  <Td className="text-muted">{r.row}</Td>
                  {fields.map((f) => <Td key={f.key}>{r.data[f.key] ?? ""}</Td>)}
                  <Td>
                    <Badge tone={ROW_STATUS[r.status].tone}>{ROW_STATUS[r.status].label}</Badge>
                    {r.messages.length ? <p className="mt-1 text-xs text-muted">{r.messages.join(" ")}</p> : null}
                  </Td>
                  <Td className="whitespace-nowrap">
                    {review ? (
                      r.status === "valid" || r.can_override ? (
                        <form action={actions.decide} className="flex items-center gap-2">
                          <input type="hidden" name="batch" value={batch.id} />
                          <input type="hidden" name="row" value={r.id} />
                          <input type="hidden" name="decision" value={r.decision === "import" ? "skip" : "import"} />
                          <span className={r.decision === "import" ? "font-semibold text-green-800" : "text-muted"}>{r.decision === "import" ? "Import" : "Skip"}</span>
                          <SubmitButton size="sm" variant="secondary">{r.decision === "import" ? "Skip it" : "Import it"}</SubmitButton>
                        </form>
                      ) : (
                        <span className="text-muted">Skip</span>
                      )
                    ) : (
                      <span>{OUTCOME[r.outcome] ?? (r.decision === "skip" ? "Skipped" : "—")}</span>
                    )}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </TableWrap>
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        {review ? (
          <>
            <Card>
              <CardHeader title="Approve" description={`Creates ${toImport} ${ENTITY_LABELS[batch.entity].toLowerCase()} in ${companyName}.`} />
              <CardBody>
                <form action={actions.approve} className="space-y-3">
                  <input type="hidden" name="batch" value={batch.id} />
                  <label className="flex items-start gap-2 text-sm">
                    <input type="checkbox" name="confirm" value="yes" required className="mt-0.5 size-4 accent-brand" />
                    I reviewed the rows and the decisions above.
                  </label>
                  <SubmitButton disabled={toImport === 0} pendingLabel="Creating…">Approve and create {toImport}</SubmitButton>
                </form>
              </CardBody>
            </Card>
            <Card>
              <CardHeader title="Discard" description="Closes this import without creating anything." />
              <CardBody>
                <form action={actions.discard}>
                  <input type="hidden" name="batch" value={batch.id} />
                  <SubmitButton variant="secondary" pendingLabel="Discarding…">Discard</SubmitButton>
                </form>
              </CardBody>
            </Card>
          </>
        ) : null}
        {batch.status === "approved" ? afterApproved : null}
      </div>
    </>
  );
}
