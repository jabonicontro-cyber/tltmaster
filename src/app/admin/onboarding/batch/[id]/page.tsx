import { notFound } from "next/navigation";
import { AdminFlash } from "@/components/admin/flash";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/form";
import { PageHeader } from "@/components/ui/page-header";
import { SubmitButton } from "@/components/ui/submit-button";
import { formatDateTime } from "@/lib/dates";
import { ENTITY_LABELS } from "@/lib/platform/imports";
import type { ImportBatch } from "@/lib/platform/types";
import { createClient } from "@/server/supabase/server";
import { approveImport, decideImportRow, discardImport, revertImport } from "../../../actions";
import { ImportReview } from "@/components/imports/import-review";

export const metadata = { title: "Review import" };

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

      <ImportReview
        batch={batch}
        companyName={batch.company_name}
        actions={{ decide: decideImportRow, approve: approveImport, discard: discardImport }}
        afterApproved={
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
        }
      />
    </>
  );
}
