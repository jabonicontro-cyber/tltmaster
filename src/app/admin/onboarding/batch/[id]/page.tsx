import { notFound } from "next/navigation";
import { AdminFlash } from "@/components/admin/flash";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/form";
import { PageHeader } from "@/components/ui/page-header";
import { Notice } from "@/components/ui/states";
import { SubmitButton } from "@/components/ui/submit-button";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { formatDateTime } from "@/lib/dates";
import { ENTITY_LABELS, IMPORT_FIELDS } from "@/lib/platform/imports";
import type { ImportBatch, ImportRow } from "@/lib/platform/types";
import { createClient } from "@/server/supabase/server";
import { approveImport, decideImportRow, discardImport, revertImport } from "../../../actions";

export const metadata = { title: "Review import" };

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
};
const SAVED: Record<string, string> = {
  approved: "Approved. The records now exist in the company.",
  discarded: "Discarded. Nothing was created.",
  reverted: "Reverted. Records that were untouched and unused were removed; the rest were kept and deactivated.",
};

export default async function ImportBatchPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string; saved?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const supabase = await createClient();
  const { data } = await supabase.rpc("platform_import_batch", { p_batch: id });
  const batch = data as ImportBatch | null;
  if (!batch) notFound();
  const fields = IMPORT_FIELDS[batch.entity].filter((f) => batch.rows.some((r) => r.data[f.key]));
  const toImport = batch.rows.filter((r) => r.decision === "import").length;
  const counts = { valid: 0, duplicate: 0, error: 0 };
  batch.rows.forEach((r) => counts[r.status]++);
  const review = batch.status === "review";
  return (
    <>
      <PageHeader
        title={`${ENTITY_LABELS[batch.entity]} · ${batch.file_name || "Spreadsheet"}`}
        description={`${batch.company_name} · staged ${formatDateTime(batch.created_at)} · ${batch.rows.length} rows: ${counts.valid} ready, ${counts.duplicate} possible duplicates, ${counts.error} need fixing`}
        crumbs={[{ label: "Launchpad", href: "/admin" }, { label: "Onboarding", href: "/admin/onboarding" }, { label: batch.company_name, href: `/admin/onboarding/${batch.company_id}` }, { label: "Review import" }]}
        badges={<Badge tone={review ? "amber" : batch.status === "approved" ? "green" : "gray"}>{review ? "In review" : batch.status[0].toUpperCase() + batch.status.slice(1)}</Badge>}
      />
      <AdminFlash error={sp.error} saved={sp.saved} savedText={SAVED[sp.saved ?? ""] ?? "Saved."} />

      {review ? (
        <Notice title="Nothing has been created yet">
          Check each row. Rows that need fixing are never imported: correct them in the spreadsheet and import them again. A possible duplicate is skipped unless you choose to
          import it (only where the company&apos;s records allow two of the same). Approving creates the {toImport} rows marked &ldquo;Import&rdquo;, all at once or not at all.
        </Notice>
      ) : null}
      {batch.status === "reverted" ? <Notice title="Reverted">{batch.revert_reason}</Notice> : null}

      <div className="mt-5">
        <TableWrap>
          <Table>
            <thead>
              <tr>
                <Th>Row</Th>
                {fields.map((f) => (
                  <Th key={f.key}>{f.label}</Th>
                ))}
                <Th>Checks</Th>
                <Th>{review ? "Decision" : "Result"}</Th>
              </tr>
            </thead>
            <tbody>
              {batch.rows.map((r) => (
                <Tr key={r.id} id={`row-${r.id}`}>
                  <Td className="text-muted">{r.row}</Td>
                  {fields.map((f) => (
                    <Td key={f.key}>{r.data[f.key] ?? ""}</Td>
                  ))}
                  <Td>
                    <Badge tone={ROW_STATUS[r.status].tone}>{ROW_STATUS[r.status].label}</Badge>
                    {r.messages.length ? <p className="mt-1 text-xs text-muted">{r.messages.join(" ")}</p> : null}
                  </Td>
                  <Td className="whitespace-nowrap">
                    {review ? (
                      r.status === "valid" || r.can_override ? (
                        <form action={decideImportRow} className="flex items-center gap-2">
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
              <CardHeader title="Approve" description={`Creates ${toImport} ${ENTITY_LABELS[batch.entity].toLowerCase()} in ${batch.company_name}.`} />
              <CardBody>
                <form action={approveImport} className="space-y-3">
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
              <CardHeader title="Discard" description="Closes this batch without creating anything." />
              <CardBody>
                <form action={discardImport}>
                  <input type="hidden" name="batch" value={batch.id} />
                  <SubmitButton variant="secondary" pendingLabel="Discarding…">Discard</SubmitButton>
                </form>
              </CardBody>
            </Card>
          </>
        ) : null}
        {batch.status === "approved" ? (
          <Card>
            <CardHeader title="Revert this import" description="Removes the records this import created, only while they are unchanged and unused. Anything edited or used since is kept and deactivated. Nothing else is touched." />
            <CardBody>
              <form action={revertImport} className="space-y-3">
                <input type="hidden" name="batch" value={batch.id} />
                <Field label="Reason" htmlFor="reason">
                  <Input id="reason" name="reason" required maxLength={300} />
                </Field>
                <SubmitButton variant="danger" pendingLabel="Reverting…">Revert import</SubmitButton>
              </form>
            </CardBody>
          </Card>
        ) : null}
      </div>
    </>
  );
}
