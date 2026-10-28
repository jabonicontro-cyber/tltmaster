import { notFound } from "next/navigation";
import { AdminFlash } from "@/components/admin/flash";
import { ImportReview } from "@/components/imports/import-review";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/form";
import { PageHeader } from "@/components/ui/page-header";
import { SubmitButton } from "@/components/ui/submit-button";
import { formatDateTime } from "@/lib/dates";
import { ENTITY_LABELS } from "@/lib/platform/imports";
import type { ImportBatch } from "@/lib/platform/types";
import { requirePagePermission } from "@/server/auth";
import { businessToday } from "@/server/data/settings";
import { createClient } from "@/server/supabase/server";
import { approveCompanyImport, decideCompanyImportRow, discardCompanyImport, undoCompanyImport } from "../actions";

export const metadata = { title: "Review import" };

const SAVED: Record<string, string> = {
  approved: "Approved. The records now exist in your company.",
  discarded: "Discarded. Nothing was created.",
  undone: "Undone. The records this import created are now inactive; nothing was deleted.",
};
const STATUS: Record<ImportBatch["status"], { label: string; tone: "amber" | "green" | "gray" }> = {
  review: { label: "In review", tone: "amber" },
  approved: { label: "Approved", tone: "green" },
  reverted: { label: "Reverted", tone: "gray" },
  discarded: { label: "Discarded", tone: "gray" },
  deactivated: { label: "Undone", tone: "gray" },
};

/** A company's own spreadsheet import (B106): the same review the platform team uses, with Undo instead of Revert. */
export default async function CompanyImportPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string; saved?: string }> }) {
  const access = await requirePagePermission("settings.manage");
  const { id } = await params;
  const sp = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const supabase = await createClient();
  const [{ data }, { timezone }, company] = await Promise.all([
    supabase.rpc("company_import_batch", { p_batch: id }),
    businessToday(),
    supabase.from("companies").select("name").eq("id", access.companyId!).maybeSingle(),
  ]);
  const batch = data as ImportBatch | null;
  if (!batch) notFound();
  const counts = { valid: 0, duplicate: 0, error: 0 };
  batch.rows.forEach((r) => counts[r.status]++);
  const status = STATUS[batch.status];
  return (
    <>
      <PageHeader
        title={`${ENTITY_LABELS[batch.entity]} · ${batch.file_name || "Spreadsheet"}`}
        description={`Staged ${formatDateTime(batch.created_at, timezone)} · ${batch.rows.length} rows: ${counts.valid} ready, ${counts.duplicate} possible duplicates, ${counts.error} need fixing`}
        crumbs={[{ label: "Settings", href: "/settings" }, { label: "Import", href: "/settings?tab=import" }, { label: "Review import" }]}
        badges={<Badge tone={status.tone}>{status.label}</Badge>}
      />
      <AdminFlash error={sp.error} saved={sp.saved} savedText={SAVED[sp.saved ?? ""] ?? "Saved."} />
      <ImportReview
        batch={batch}
        companyName={company.data?.name ?? "your company"}
        actions={{ decide: decideCompanyImportRow, approve: approveCompanyImport, discard: discardCompanyImport }}
        afterApproved={
          <Card>
            <CardHeader title="Undo this import" description="Makes every record this import created inactive, with your reason. Nothing is deleted: inactive records stay in history and can be reactivated one by one." />
            <CardBody>
              <form action={undoCompanyImport} className="space-y-3">
                <input type="hidden" name="batch" value={batch.id} />
                <Field label="Reason" htmlFor="reason">
                  <Input id="reason" name="reason" required maxLength={300} />
                </Field>
                <SubmitButton variant="danger" pendingLabel="Undoing…">Undo import</SubmitButton>
              </form>
            </CardBody>
          </Card>
        }
      />
    </>
  );
}
