import Link from "next/link";
import { AdminFlash } from "@/components/admin/flash";
import { Badge } from "@/components/ui/badge";
import { Field, Input } from "@/components/ui/form";
import { EmptyState } from "@/components/ui/states";
import { SubmitButton } from "@/components/ui/submit-button";
import { ConsolePageHeader, DataCell, DataHead, DataRow, DataTable, Panel, PanelBody, PanelHeader, groupOf } from "@/components/admin/ui";
import { formatDate } from "@/lib/dates";
import type { PlatformCompany } from "@/lib/platform/types";
import { createClient } from "@/server/supabase/server";
import { createCompany } from "../actions";
import { platformOnboardingOverview } from "@/server/data/onboarding";

export const metadata = { title: "Onboarding" };

export default async function OnboardingPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const sp = await searchParams;
  const supabase = await createClient();
  const { data } = await supabase.rpc("platform_companies");
  const companies = (data ?? []) as PlatformCompany[];
  const overview = await platformOnboardingOverview();
  const progress = new Map(overview.ok ? overview.data.map((r) => [r.company_id, r.summary]) : []);
  return (
    <>
      <ConsolePageHeader eyebrow={groupOf("/admin/onboarding")} title="Company onboarding" description="Set up a customer company with the team: create it, import its records from spreadsheets, review, approve." />
      <AdminFlash error={sp.error} />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0">
          {companies.length === 0 ? (
            <EmptyState title="No companies yet" description="Create the first one with New company." className="rounded-xl border border-line bg-card" />
          ) : (
            <DataTable aria-label="Companies being onboarded" head={<><DataHead>Company</DataHead><DataHead>Onboarding</DataHead><DataHead align="right">Users</DataHead><DataHead align="right">Customers</DataHead><DataHead align="right">Materials</DataHead><DataHead align="right">Trucks</DataHead><DataHead align="right">Drivers</DataHead><DataHead>Created</DataHead></>}>
              {companies.map((c) => {
                const p = progress.get(c.id);
                return (
                  <DataRow key={c.id}>
                    <DataCell primary>
                      <span className="flex flex-wrap items-center gap-2">
                        <Link href={`/admin/onboarding/${c.id}`} className="font-semibold text-ink hover:text-brand-fg hover:underline">{c.name}</Link>
                        {!c.active ? <Badge>Inactive</Badge> : null}
                      </span>
                    </DataCell>
                    <DataCell label="Onboarding">
                      {!p ? (
                        <span className="text-sm text-muted">Not started</span>
                      ) : (
                        <span className="flex flex-wrap items-center gap-1.5 text-xs">
                          <span className="text-sm font-semibold whitespace-nowrap text-ink tabular">{p.required_done} of {p.required}</span>
                          {p.review ? <Badge tone="blue">{p.review} to review</Badge> : null}
                          {p.customer_actions ? <Badge tone="amber">{p.customer_actions} with customer</Badge> : null}
                          {p.blocked ? <Badge tone="critical-soft">{p.blocked} blocked</Badge> : null}
                          {p.overdue ? <Badge tone="critical-soft">{p.overdue} overdue</Badge> : null}
                          {p.ready ? <Badge tone="green">Ready for go-live review</Badge> : null}
                        </span>
                      )}
                    </DataCell>
                    <DataCell label="Users" align="right">{c.members}</DataCell>
                    <DataCell label="Customers" align="right">{c.customers}</DataCell>
                    <DataCell label="Materials" align="right">{c.materials}</DataCell>
                    <DataCell label="Trucks" align="right">{c.trucks}</DataCell>
                    <DataCell label="Drivers" align="right">{c.drivers}</DataCell>
                    <DataCell label="Created" className="whitespace-nowrap text-muted tabular">{formatDate(c.created_at.slice(0, 10))}</DataCell>
                  </DataRow>
                );
              })}
            </DataTable>
          )}
        </div>
        <Panel className="self-start lg:sticky lg:top-36">
          <PanelHeader title="New company" description="Created without users. A Taviron Admin adds its owner's login afterwards." />
          <PanelBody>
            <form action={createCompany} className="space-y-3">
              <Field label="Company name" htmlFor="name">
                <Input id="name" name="name" required maxLength={120} />
              </Field>
              <Field label="Time zone" htmlFor="timezone">
                <Input id="timezone" name="timezone" defaultValue="America/Chicago" required />
              </Field>
              <SubmitButton pendingLabel="Creating…" className="w-full">Create company</SubmitButton>
            </form>
          </PanelBody>
        </Panel>
      </div>
    </>
  );
}
