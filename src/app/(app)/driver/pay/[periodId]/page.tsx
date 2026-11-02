import { notFound } from "next/navigation";
import { PayStatement, type PayStatementData } from "@/components/payroll/pay-statement";
import { ButtonLink } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { requirePagePermission } from "@/server/auth";
import { createClient } from "@/server/supabase/server";

export const metadata = { title: "My pay statement" };

/** A driver's own pay statement (B131), only for approved periods; the database refuses anything else. */
export default async function MyStatementPage({ params }: { params: Promise<{ periodId: string }> }) {
  const access = await requirePagePermission("driver.portal");
  const { periodId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(periodId)) notFound();
  const { data, error } = await (await createClient()).rpc("my_pay_statement", { p_period: periodId });
  if (error || !data) notFound();
  return (
    <>
      <PageHeader title="My pay statement" actions={<ButtonLink href="/driver" variant="secondary">My Day</ButtonLink>} />
      <PayStatement s={data as PayStatementData} company={access.companyName ?? ""} />
    </>
  );
}
