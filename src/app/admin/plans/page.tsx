import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { DateInput } from "@/components/ui/date-input";
import { FlashToast } from "@/components/ui/flash-toast";
import { Checkbox, Field, Input, Select } from "@/components/ui/form";
import { PageHeader } from "@/components/ui/page-header";
import { ErrorState, Notice } from "@/components/ui/states";
import { SubmitButton } from "@/components/ui/submit-button";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { formatDate } from "@/lib/dates";
import type { PlanVersion } from "@/lib/platform/lifecycle";
import { usd } from "@/lib/site/pricing";
import { createClient } from "@/server/supabase/server";
import { createPlanVersion } from "../lifecycle-actions";

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
        <ErrorState title={error.code === "PGRST202" ? "Plans need a database update" : "Plans could not be loaded"} description={error.code === "PGRST202" ? "Apply migration 20261118000300 (owner step)." : "Nothing is shown rather than guessed."} />
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
                    <Td className="text-xs text-muted">{p.trucks ? `${p.trucks} trucks · ${p.bases} base${p.bases === 1 ? "" : "s"}` : "—"}</Td>
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
            <form action={createPlanVersion} className="space-y-3">
              <Field label="Plan" htmlFor="plan_key">
                <Select id="plan_key" name="plan_key" required defaultValue="">
                  <option value="" disabled>Choose a plan</option>
                  {keys.map(([k, n]) => <option key={k} value={k}>{n}</option>)}
                </Select>
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Monthly ($)" htmlFor="monthly"><Input id="monthly" name="monthly" inputMode="decimal" placeholder="499" /></Field>
                <Field label="Onboarding ($)" htmlFor="onboarding"><Input id="onboarding" name="onboarding" inputMode="decimal" placeholder="199" /></Field>
              </div>
              <Field label="First day" htmlFor="effective_from"><DateInput id="effective_from" name="effective_from" required /></Field>
              <Field label="Note" htmlFor="note"><Input id="note" name="note" maxLength={500} placeholder="Why the price changes" /></Field>
              <Checkbox name="confirm" label="Save this new price version" />
              <p className="text-xs text-muted">The public pricing page is not changed by this; update it separately.</p>
              <SubmitButton pendingLabel="Saving…">Save version</SubmitButton>
            </form>
          </CardBody>
        </Card>
      </div>
    </>
  );
}
