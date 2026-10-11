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

export const metadata = { title: "Company onboarding" };

const BATCH_STATUS: Record<ImportBatchSummary["status"], { label: string; tone: "amber" | "green" | "gray" }> = {
  review: { label: "In review", tone: "amber" },
  approved: { label: "Approved", tone: "green" },
  reverted: { label: "Reverted", tone: "gray" },
  discarded: { label: "Discarded", tone: "gray" },
};

export default async function CompanyOnboardingPage({ params, searchParams }: { params: Promise<{ companyId: string }>; searchParams: Promise<{ error?: string; created?: string }> }) {
  const { companyId } = await params;
  const sp = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(companyId)) notFound();
  const supabase = await createClient();
  const [{ data: companies }, { data: batches }] = await Promise.all([supabase.rpc("platform_companies"), supabase.rpc("platform_import_batches", { p_company: companyId })]);
  const company = ((companies ?? []) as PlatformCompany[]).find((c) => c.id === companyId);
  if (!company) notFound();
  const list = (batches ?? []) as ImportBatchSummary[];
  return (
    <>
      <PageHeader
        title={company.name}
        description={`${company.members} users · ${company.customers} customers · ${company.materials} materials · ${company.trucks} trucks · ${company.drivers} drivers`}
        crumbs={[{ label: "Launchpad", href: "/admin" }, { label: "Onboarding", href: "/admin/onboarding" }, { label: company.name }]}
      />
      <AdminFlash error={sp.error} saved={sp.created} savedText="Company created. Import its records below." />
      <div className="space-y-5">
        <Card>
          <CardHeader title="Import from a spreadsheet" description="Records are created only after you review and approve the batch. An approved batch can be reverted." />
          <CardBody>
            <ImportUploader companyId={company.id} />
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
