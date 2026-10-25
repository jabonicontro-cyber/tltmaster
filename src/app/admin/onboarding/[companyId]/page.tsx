import { ButtonLink } from "@/components/ui/button";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AdminFlash } from "@/components/admin/flash";
import { ImportUploader } from "@/components/admin/import-uploader";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { formatDateTime } from "@/lib/dates";
import { ENTITY_LABELS, type ImportEntity } from "@/lib/platform/imports";
import type { ImportBatchSummary, PlatformCompany } from "@/lib/platform/types";
import { createClient } from "@/server/supabase/server";
import { IMPORT_ENTITIES, MAX_IMPORT_BYTES } from "@/lib/platform/imports";
import { todayIn } from "@/lib/dates";
import { platformOnboarding } from "@/server/data/onboarding";
import { OnboardingChecklist } from "@/components/onboarding/checklist";
import { GenerateChecklistButton } from "@/components/onboarding/task-forms";

/** A CSV the company uploaded to its checklist, read with the platform admin's own access (database + storage RLS). */
async function documentForImport(documentId: string | undefined, entity: string | undefined) {
  if (!documentId || !/^[0-9a-f-]{36}$/i.test(documentId) || !IMPORT_ENTITIES.includes(entity as never)) return null;
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("onboarding_document_path", { p_document: documentId });
  const doc = data as { object_path: string; file_name: string; mime_type: string } | null;
  if (error || !doc || doc.mime_type !== "text/csv") return { error: "That file cannot be imported (only CSV files on this company's checklist)." };
  const file = await supabase.storage.from("onboarding-documents").download(doc.object_path);
  if (file.error || !file.data) return { error: "The file could not be read from storage." };
  if (file.data.size > MAX_IMPORT_BYTES) return { error: "The file is too large to import at once. Ask the company to split it." };
  return { csv: await file.data.text(), fileName: doc.file_name, entity: entity as (typeof IMPORT_ENTITIES)[number], documentId };
}

export const metadata = { title: "Company onboarding" };

const BATCH_STATUS: Record<ImportBatchSummary["status"], { label: string; tone: "amber" | "green" | "gray" }> = {
  review: { label: "In review", tone: "amber" },
  approved: { label: "Approved", tone: "green" },
  reverted: { label: "Reverted", tone: "gray" },
  discarded: { label: "Discarded", tone: "gray" },
};

export default async function CompanyOnboardingPage({ params, searchParams }: { params: Promise<{ companyId: string }>; searchParams: Promise<{ error?: string; created?: string; document?: string; entity?: string }> }) {
  const { companyId } = await params;
  const sp = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(companyId)) notFound();
  const supabase = await createClient();
  const [{ data: companies }, { data: batches }] = await Promise.all([supabase.rpc("platform_companies"), supabase.rpc("platform_import_batches", { p_company: companyId })]);
  const company = ((companies ?? []) as PlatformCompany[]).find((c) => c.id === companyId);
  if (!company) notFound();
  const list = (batches ?? []) as ImportBatchSummary[];
  const [checklist, fromDocument] = await Promise.all([platformOnboarding(company.id), documentForImport(sp.document, sp.entity)]);
  return (
    <>
      <PageHeader
        title={company.name}
        description={`${company.members} users · ${company.customers} customers · ${company.materials} materials · ${company.trucks} trucks · ${company.drivers} drivers`}
        crumbs={[{ label: "Launchpad", href: "/admin" }, { label: "Onboarding", href: "/admin/onboarding" }, { label: company.name }]}
        actions={<ButtonLink href={`/admin/onboarding/${company.id}/kit`}>Onboarding Kit</ButtonLink>}
      />
      <AdminFlash error={sp.error} saved={sp.created} savedText="Company created. Import its records below." />
      <div className="space-y-5">
        <Card>
          <CardHeader
            title="Onboarding checklist"
            description="Generated from the company's plan, fleet, bases, portal entitlement and configured integrations. The company works on its tasks under Company setup; you approve, request changes and remind (in-app only). Approving never changes the go-live date, the lifecycle stage or billing."
            actions={checklist.ok ? <GenerateChecklistButton companyId={company.id} hasTasks={checklist.data.tasks.length > 0} /> : null}
          />
          <CardBody>
            {!checklist.ok ? (
              <p className="text-sm text-muted">{checklist.message}</p>
            ) : checklist.data.tasks.length === 0 ? (
              <p className="text-sm text-muted">No checklist yet. Start onboarding to create one from what Taviron knows about this company today; nothing is sent to the company.</p>
            ) : (
              <OnboardingChecklist state={checklist.data} side="staff" companyId={company.id} today={todayIn("America/Chicago")} />
            )}
          </CardBody>
        </Card>
        <Card>
          <div id="import" className="scroll-mt-24" />
          <CardHeader title="Import from a spreadsheet" description="Records are created only after you review and approve the batch. An approved batch can be reverted." />
          <CardBody>
            {fromDocument && "error" in fromDocument ? <p role="alert" className="mb-3 text-sm text-critical">{fromDocument.error}</p> : null}
            {fromDocument && !("error" in fromDocument) ? (
              <p className="mb-3 rounded-xl border border-line bg-surface p-3 text-sm text-ink">
                Opened <strong>{fromDocument.fileName}</strong> from the company&apos;s onboarding checklist. Check the columns and the preview; staging creates nothing until you approve the batch.
              </p>
            ) : null}
            <ImportUploader key={fromDocument && !("error" in fromDocument) ? fromDocument.documentId : "upload"} companyId={company.id} initial={fromDocument && !("error" in fromDocument) ? fromDocument : undefined} />
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Imports" />
          {list.length === 0 ? (
            <CardBody>
              <p className="text-sm text-muted">No imports yet.</p>
            </CardBody>
          ) : (
            <TableWrap className="rounded-none border-0">
              <Table>
                <thead>
                  <tr>
                    <Th>File</Th>
                    <Th>Contains</Th>
                    <Th>Status</Th>
                    <Th align="right">Rows</Th>
                    <Th align="right">To import / created</Th>
                    <Th>Staged</Th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((b) => (
                    <Tr key={b.id}>
                      <Td>
                        <Link href={`/admin/onboarding/batch/${b.id}`} className="font-semibold hover:underline">{b.file_name || "Spreadsheet"}</Link>
                      </Td>
                      <Td>{ENTITY_LABELS[b.entity as ImportEntity] ?? b.entity}</Td>
                      <Td><Badge tone={BATCH_STATUS[b.status].tone}>{BATCH_STATUS[b.status].label}</Badge></Td>
                      <Td align="right">{b.rows}</Td>
                      <Td align="right">{b.status === "review" ? b.to_import : (b.result.created ?? 0)}</Td>
                      <Td className="whitespace-nowrap">{formatDateTime(b.created_at)}{b.created_by ? <span className="block text-xs text-muted">{b.created_by}</span> : null}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </TableWrap>
          )}
        </Card>
      </div>
    </>
  );
}
