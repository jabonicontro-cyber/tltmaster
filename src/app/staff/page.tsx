import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/form";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState, Notice } from "@/components/ui/states";
import { SubmitButton } from "@/components/ui/submit-button";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { formatDateTime } from "@/lib/dates";
import { requirePlatformStaff } from "@/server/platform";
import { createClient } from "@/server/supabase/server";
import { enterCompany, leaveCompany } from "./actions";

export const metadata = { title: "Company access" };

type Row = { id: string; name: string; is_demo: boolean; stage: string; needs_grant: boolean; grant_ends_at: string | null; can_enter: boolean; my_visit_ends_at: string | null; last_visit_at: string | null };

const STAGE: Record<string, string> = { fee_due: "Onboarding fee due", onboarding: "Onboarding", live: "Live", canceled: "Canceled", demo: "Demo" };

function access(r: Row): { label: string; tone: "green" | "blue" | "gray" | "amber" } {
  if (!r.needs_grant) return { label: r.is_demo ? "Demo: open" : "Being set up: open", tone: "blue" };
  if (r.grant_ends_at) return { label: `Allowed until ${formatDateTime(r.grant_ends_at)}`, tone: "green" };
  return { label: "Not allowed", tone: "gray" };
}

/**
 * Company access (SA1, owner 2026-11-06). Live companies let Taviron in only when an owner allows it in Settings,
 * Taviron support (1, 3 or 7 days); companies still being set up are open. Inside, a team member works with the
 * owner's permissions; the company's owners see a banner and every change shows as "Name (Taviron support)".
 */
export default async function StaffDeskPage({ searchParams }: { searchParams: Promise<{ error?: string; left?: string; q?: string }> }) {
  await requirePlatformStaff();
  const sp = await searchParams;
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("platform_support_companies");
  const q = (sp.q ?? "").trim().toLowerCase().slice(0, 80);
  const all = (data ?? []) as Row[];
  const rows = q ? all.filter((r) => r.name.toLowerCase().includes(q) || r.my_visit_ends_at) : all;
  const inside = rows.find((r) => r.my_visit_ends_at);
  const customers = rows.filter((r) => !r.is_demo);
  const demos = rows.filter((r) => r.is_demo);
  return (
    <>
      <PageHeader title="Company access" description="Go into a customer's company to help or make a quick change. Live companies need their owner's permission first; companies still being set up are open." />
      {sp.error ? <div className="mb-4"><Notice tone="warning" title="Could not go in">{sp.error}</Notice></div> : null}
      {sp.left ? <div className="mb-4"><Notice title="You left the company">Your visit has ended.</Notice></div> : null}
      {error ? (
        <EmptyState title="Not available yet" description="Company access needs the database update 20261120008900, which is not installed yet." />
      ) : (
        <div className="space-y-5">
          {inside && (
            <Card>
              <CardBody className="flex flex-wrap items-center gap-3">
                <div className="min-w-0 flex-1">
                  <p className="font-semibold text-ink">You are in {inside.name}</p>
                  <p className="text-sm text-muted">Until {formatDateTime(inside.my_visit_ends_at!)}. Its owners see that Taviron support is in their account.</p>
                </div>
                <a href="/command-center" className="text-sm font-semibold text-brand-fg hover:underline">Open it</a>
                <form action={leaveCompany}><SubmitButton variant="secondary" size="sm">Leave</SubmitButton></form>
              </CardBody>
            </Card>
          )}
          <form method="get" className="flex items-center gap-2" role="search" aria-label="Find a company">
            <div className="w-full max-w-sm"><Input name="q" defaultValue={sp.q ?? ""} placeholder="Find a company by name" aria-label="Company name" maxLength={80} /></div>
            <SubmitButton variant="secondary" size="sm">Find</SubmitButton>
            {q ? <a href="/staff" className="text-sm font-semibold text-brand-fg hover:underline">Show all</a> : null}
          </form>
          <CompanyTable title="Customer companies" rows={customers} empty={q ? "No customer company matches that name." : "No customer companies yet."} />
          {demos.length > 0 && <CompanyTable title="Demo companies" rows={demos} empty="" />}
        </div>
      )}
    </>
  );
}

function CompanyTable({ title, rows, empty }: { title: string; rows: Row[]; empty: string }) {
  return (
    <Card>
      <CardHeader title={title} description={title.startsWith("Customer") ? "Say briefly what you are helping with: the company sees it in its visit history." : "Fictional data; nothing real is sent from a demo."} />
      {rows.length === 0 ? (
        <CardBody><p className="text-sm text-muted">{empty}</p></CardBody>
      ) : (
        <TableWrap className="rounded-none border-0">
          <Table aria-label={title}>
            <thead><tr><Th>Company</Th><Th>Stage</Th><Th>Taviron access</Th><Th>Last visit</Th><Th className="text-right">Go in</Th></tr></thead>
            <tbody>
              {rows.map((r) => {
                const a = access(r);
                return (
                  <Tr key={r.id}>
                    <Td className="font-semibold">{r.name}</Td>
                    <Td>{STAGE[r.stage] ?? r.stage}</Td>
                    <Td><Badge tone={a.tone}>{a.label}</Badge></Td>
                    <Td className="whitespace-nowrap text-muted">{r.last_visit_at ? formatDateTime(r.last_visit_at) : "Never"}</Td>
                    <Td className="text-right">
                      {r.my_visit_ends_at ? (
                        <a href="/command-center" className="text-sm font-semibold text-brand-fg hover:underline">Open (you are in)</a>
                      ) : r.can_enter ? (
                        <form action={enterCompany} className="flex items-center justify-end gap-2" aria-label={`Go into ${r.name}`}>
                          <input type="hidden" name="company" value={r.id} />
                          <Input name="reason" placeholder="What are you helping with?" aria-label={`What are you helping ${r.name} with?`} maxLength={300} className="hidden w-56 md:block" />
                          <SubmitButton size="sm">Go in</SubmitButton>
                        </form>
                      ) : (
                        <span className="text-xs text-muted">Waiting for the owner</span>
                      )}
                    </Td>
                  </Tr>
                );
              })}
            </tbody>
          </Table>
        </TableWrap>
      )}
    </Card>
  );
}
