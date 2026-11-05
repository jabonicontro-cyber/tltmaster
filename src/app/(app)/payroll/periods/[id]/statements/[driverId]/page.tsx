import { notFound } from "next/navigation";
import { PrintButton } from "@/components/quotes/print-button";
import { PayStatement, type PayStatementData } from "@/components/payroll/pay-statement";
import { ButtonLink } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { Notice } from "@/components/ui/states";
import { formatDate } from "@/lib/dates";
import { requirePagePermission } from "@/server/auth";
import { createClient } from "@/server/supabase/server";

export const metadata = { title: "Pay statement" };

/** A driver's pay statement for a payroll period (B131), to print or hand out. payroll.manage. */
export default async function StatementPage({ params }: { params: Promise<{ id: string; driverId: string }> }) {
  const access = await requirePagePermission("payroll.manage");
  const { id, driverId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id) || !/^[0-9a-f-]{36}$/i.test(driverId)) notFound();
  const { data, error } = await (await createClient()).rpc("payroll_statement", { p_period: id, p_driver: driverId });
  if (error || !data) notFound();
  const s = data as PayStatementData;
  const draft = !["approved", "exported", "reconciled"].includes(s.period.status);
  return (
    <>
      <PageHeader
        title={`Pay statement · ${s.driver.name}`}
        crumbs={[{ label: "Payroll", href: "/payroll" }, { label: `${formatDate(s.period.starts_on)} – ${formatDate(s.period.ends_on)}`, href: `/payroll/periods/${id}` }, { label: s.driver.name }]}
        actions={<div className="flex gap-2 print:hidden"><PrintButton /><ButtonLink href={`/payroll/periods/${id}`} variant="secondary">Period</ButtonLink></div>}
      />
      {draft && <div className="mb-4 print:hidden"><Notice tone="warning" title="Not approved yet">This period can still change. The driver sees their statement only after you approve the period.</Notice></div>}
      <PayStatement s={s} company={access.companyName ?? ""} />
    </>
  );
}
