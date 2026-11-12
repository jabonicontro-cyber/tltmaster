import { Badge } from "@/components/ui/badge";
import { DateInput } from "@/components/ui/date-input";
import { FlashToast } from "@/components/ui/flash-toast";
import { Checkbox, Field, Input, Select } from "@/components/ui/form";
import { ErrorState, Notice } from "@/components/ui/states";
import { SubmitButton } from "@/components/ui/submit-button";
import { ConsolePageHeader, DataCell, DataHead, DataRow, DataTable, Panel, PanelBody, PanelHeader, groupOf } from "@/components/admin/ui";
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
        <ConsolePageHeader eyebrow={groupOf("/admin/plans")} title="Plans and prices" />
        <ErrorState title={error.code === "PGRST202" ? "Plans need a database update" : "Plans could not be loaded"} description={error.code === "PGRST202" ? "A Taviron Admin installs it. Nothing is shown rather than guessed." : "Nothing is shown rather than guessed."} />
      </>
    );
  }
  const plans = (data ?? []) as PlanVersion[];
  const keys = [...new Map(plans.map((p) => [p.plan_key, p.name])).entries()];
  return (
    <>
      <FlashToast messages={{ saved: { text: "New price version saved." } }} />
      <ConsolePageHeader eyebrow={groupOf("/admin/plans")} title="Plans and prices" description="Every price version, newest first. Companies keep the version they signed; a new price applies to companies that choose it afterwards." />
      {sp.error && <div className="mb-5"><Notice tone="warning" title="Not saved">{sp.error}</Notice></div>}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <DataTable aria-label="Price versions" className="self-start" head={<><DataHead>Plan</DataHead><DataHead align="right">Monthly</DataHead><DataHead align="right">Onboarding</DataHead><DataHead>Limits</DataHead><DataHead>From</DataHead><DataHead align="right">Companies</DataHead></>}>
          {plans.map((p) => (
            <DataRow key={p.id}>
              <DataCell primary>
                <span className="flex flex-wrap items-center gap-2"><span className="font-semibold text-ink">{p.name}</span> <span className="text-sm text-muted">Version {p.version}</span> {p.current && <Badge tone="green">Current</Badge>}</span>
                {p.note && <span className="mt-0.5 block text-xs text-muted">{p.note}</span>}
              </DataCell>
              <DataCell label="Monthly" align="right" className="whitespace-nowrap">{p.monthly_cents === null ? "Quoted" : `${p.from_price ? "from " : ""}${usd(p.monthly_cents)}`}</DataCell>
              <DataCell label="Onboarding" align="right" className="whitespace-nowrap">{p.onboarding_cents === null ? "Quoted" : usd(p.onboarding_cents)}</DataCell>
              <DataCell label="Limits" className="text-sm text-muted">{p.trucks ? `${p.trucks} trucks · ${p.bases} base${p.bases === 1 ? "" : "s"}` : "–"}</DataCell>
              <DataCell label="From" className="whitespace-nowrap tabular">{formatDate(p.effective_from)}</DataCell>
              <DataCell label="Companies" align="right">{p.companies}</DataCell>
            </DataRow>
          ))}
        </DataTable>
        <Panel className="self-start">
          <PanelHeader title="New price version" description="From today or a later day. Earlier versions never change." />
          <PanelBody>
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
              <p className="text-xs text-muted">The public pricing page does not change with this; it is updated separately.</p>
              <SubmitButton pendingLabel="Saving…">Save version</SubmitButton>
            </form>
          </PanelBody>
        </Panel>
      </div>
    </>
  );
}
