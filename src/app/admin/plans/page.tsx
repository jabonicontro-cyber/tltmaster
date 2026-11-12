import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { FlashToast } from "@/components/ui/flash-toast";
import { PageHeader } from "@/components/ui/page-header";
import { ErrorState, Notice } from "@/components/ui/states";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { formatDate } from "@/lib/dates";
import type { PlanVersion } from "@/lib/platform/lifecycle";
import { usd } from "@/lib/site/pricing";
import { createClient } from "@/server/supabase/server";
import { PlanVersionForm } from "@/components/admin/plan-version-form";

export const metadata = { title: "Plans and prices" };

/**
 * The plan catalog (20261118000300), versioned: a price change is a new version from a day that is not in the past, and
 * companies keep the version they signed. The public pricing page reads src/lib/site/pricing.ts, which is changed
 * separately (and on purpose) by a person.
 */
export default async function PlansPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const sp = await searchParams;
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("platform_plans");
  if (error) {
    return (
      <>
        <PageHeader title="Plans and prices" />
        <ErrorState title={error.code === "PGRST202" ? "Plans need a database update" : "Plans could not be loaded"} description={error.code === "PGRST202" ? "Plans and prices are not available on this database yet." : "Nothing is shown rather than guessed."} />
      </>
    );
  }
  const plans = (data ?? []) as PlanVersion[];
  const keys = [...new Map(plans.map((p) => [p.plan_key, p.name])).entries()];
  return (
    <>
      <FlashToast messages={{ saved: { text: "New price version saved." } }} />
      <PageHeader title="Plans and prices" description="Every price version, newest first. Companies keep the version they signed; a new price applies to companies that choose it afterwards." crumbs={[{ label: "Launchpad", href: "/admin" }, { label: "Plans and prices" }]} />
      {sp.error && <div className="mb-4"><Notice tone="warning" title="Not saved">{sp.error}</Notice></div>}
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[1fr_360px]">
        <Card>
          <TableWrap className="rounded-none border-0">
            <Table>
              <thead><tr><Th>Plan</Th><Th align="right">Monthly</Th><Th align="right">Onboarding</Th><Th>Limits</Th><Th>From</Th><Th align="right">Companies</Th></tr></thead>
              <tbody>
                {plans.map((p) => (
                  <Tr key={p.id}>
                    <Td><span className="font-semibold">{p.name}</span> <span className="text-muted">v{p.version}</span> {p.current && <Badge tone="green">Current</Badge>}{p.note && <span className="block text-xs text-muted">{p.note}</span>}</Td>
                    <Td align="right" className="tabular">{p.monthly_cents === null ? "Quoted" : `${p.from_price ? "from " : ""}${usd(p.monthly_cents)}`}</Td>
                    <Td align="right" className="tabular">{p.onboarding_cents === null ? "Quoted" : usd(p.onboarding_cents)}</Td>
                    <Td className="text-xs text-muted">{p.trucks ? `${p.trucks} trucks · ${p.bases} base${p.bases === 1 ? "" : "s"}` : "–"}</Td>
                    <Td className="whitespace-nowrap">{formatDate(p.effective_from)}</Td>
                    <Td align="right">{p.companies}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </TableWrap>
        </Card>
        <Card>
          <CardHeader title="New price version" description="From today or a later day. Earlier versions never change." />
          <CardBody>
            <PlanVersionForm plans={keys} />
          </CardBody>
        </Card>
      </div>
    </>
  );
}
