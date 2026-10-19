import Link from "next/link";
import { AdminFlash } from "@/components/admin/flash";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/form";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/states";
import { SubmitButton } from "@/components/ui/submit-button";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
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
      <PageHeader title="Company onboarding" description="Set up a customer company with the team: create it, import its records from spreadsheets, review, approve." crumbs={[{ label: "Launchpad", href: "/admin" }, { label: "Onboarding" }]} />
      <AdminFlash error={sp.error} />
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1fr_340px]">
        {companies.length === 0 ? (
          <EmptyState title="No companies yet" />
        ) : (
          <TableWrap>
            <Table>
              <thead>
                <tr>
                  <Th>Company</Th>
                  <Th align="right">Users</Th>
                  <Th align="right">Customers</Th>
                  <Th align="right">Materials</Th>
                  <Th align="right">Trucks</Th>
                  <Th align="right">Drivers</Th>
                  <Th>Onboarding</Th>
                  <Th>Created</Th>
                </tr>
              </thead>
              <tbody>
                {companies.map((c) => (
                  <Tr key={c.id}>
                    <Td>
                      <Link href={`/admin/onboarding/${c.id}`} className="font-semibold hover:underline">{c.name}</Link>
                      {!c.active ? <Badge className="ml-2">Inactive</Badge> : null}
                    </Td>
                    <Td align="right">{c.members}</Td>
                    <Td align="right">{c.customers}</Td>
                    <Td align="right">{c.materials}</Td>
                    <Td align="right">{c.trucks}</Td>
                    <Td align="right">{c.drivers}</Td>
                    <Td>
                      {(() => {
                        const p = progress.get(c.id);
                        if (!p) return <span className="text-xs text-muted">Not started</span>;
                        return (
                          <span className="flex flex-wrap items-center gap-1 text-xs">
                            <span className="font-semibold text-ink tabular-nums">{p.required_done}/{p.required}</span>
                            {p.review ? <Badge tone="blue">{p.review} to review</Badge> : null}
                            {p.customer_actions ? <Badge tone="amber">{p.customer_actions} with customer</Badge> : null}
                            {p.blocked ? <Badge tone="critical-soft">{p.blocked} blocked</Badge> : null}
                            {p.overdue ? <Badge tone="critical-soft">{p.overdue} overdue</Badge> : null}
                            {p.ready ? <Badge tone="green">Ready for go-live review</Badge> : null}
                          </span>
                        );
                      })()}
                    </Td>
                    <Td>{formatDate(c.created_at.slice(0, 10))}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </TableWrap>
        )}
        <Card>
          <CardHeader title="New company" description="Created without users. Its owner's login is added afterwards (see docs/DEPLOYMENT.md §3)." />
          <CardBody>
            <form action={createCompany} className="space-y-3">
              <Field label="Company name" htmlFor="name">
                <Input id="name" name="name" required maxLength={120} />
              </Field>
              <Field label="Time zone" htmlFor="timezone">
                <Input id="timezone" name="timezone" defaultValue="America/Chicago" required />
              </Field>
              <SubmitButton pendingLabel="Creating…">Create company</SubmitButton>
            </form>
          </CardBody>
        </Card>
      </div>
    </>
  );
}
