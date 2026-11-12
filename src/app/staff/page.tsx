import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowRight, History, Inbox, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/form";
import { EmptyState, Notice } from "@/components/ui/states";
import { SubmitButton } from "@/components/ui/submit-button";
import { HealthBadge } from "@/components/admin/company-insights";
import { formatDateTime } from "@/lib/dates";
import { stageLabel, type CompanyHealth } from "@/lib/platform/console";
import { companyHealth, supportInbox } from "@/server/data/console";
import { requirePlatformStaff } from "@/server/platform";
import { createClient } from "@/server/supabase/server";
import { enterCompany, leaveCompany } from "./actions";
import { ConsolePageHeader, DataCell, DataHead, DataRow, DataTable, Panel, PanelBody, PanelHeader, groupOf } from "@/components/admin/ui";

export const metadata = { title: "Company access" };

type Row = { id: string; name: string; is_demo: boolean; stage: string; needs_grant: boolean; grant_ends_at: string | null; can_enter: boolean; my_visit_ends_at: string | null; last_visit_at: string | null };

function access(r: Row): { label: string; tone: "green" | "blue" | "gray" | "amber" } {
  if (!r.needs_grant) return { label: r.is_demo ? "Demo: open" : "Being set up: open", tone: "blue" };
  if (r.grant_ends_at) return { label: `Allowed until ${formatDateTime(r.grant_ends_at)}`, tone: "green" };
  return { label: "Not allowed", tone: "gray" };
}

/**
 * Company access (SA1, owner 2026-11-06). Live companies let Taviron in only when an owner allows it in Settings,
 * Taviron support (1, 3 or 7 days); companies still being set up are open. Inside, a team member works with the
 * owner's permissions; the company's owners see a banner and every change shows as "Name (Taviron support)".
 * Each company also shows its health at a glance (PC1, counts only), and the desk links to the support inbox, the
 * staff member's own visits and change requests, and search.
 */
export default async function StaffDeskPage({ searchParams }: { searchParams: Promise<{ error?: string; left?: string; q?: string }> }) {
  await requirePlatformStaff();
  const sp = await searchParams;
  const supabase = await createClient();
  const [{ data, error }, health, inbox] = await Promise.all([supabase.rpc("platform_support_companies"), companyHealth(), supportInbox("new")]);
  const q = (sp.q ?? "").trim().toLowerCase().slice(0, 80);
  const all = (data ?? []) as Row[];
  const rows = q ? all.filter((r) => r.name.toLowerCase().includes(q) || r.my_visit_ends_at) : all;
  const inside = rows.find((r) => r.my_visit_ends_at);
  const customers = rows.filter((r) => !r.is_demo);
  const demos = rows.filter((r) => r.is_demo);
  const healthById = new Map((health.ok ? health.data.rows : []).map((h) => [h.company_id, h]));
  const now = health.ok ? health.data.now : 0;
  const newRequests = inbox.ok ? inbox.data.counts.new : null;
  return (
    <>
      <ConsolePageHeader eyebrow={groupOf("/staff")} title="Company access" description="Go into a customer's company to help or make a quick change. Live companies need their owner's permission first; companies still being set up are open." />
      {sp.error ? <div className="mb-4"><Notice tone="warning" title="Could not go in">{sp.error}</Notice></div> : null}
      {sp.left ? <div className="mb-4"><Notice title="You left the company">Your visit has ended.</Notice></div> : null}
      <nav aria-label="Support desk" className="mb-5 grid grid-cols-1 gap-2 sm:grid-cols-3">
        <DeskLink href="/staff/support" icon={<Inbox className="size-4" aria-hidden />} label="Support inbox" sub={newRequests === null ? "Requests from Help" : newRequests ? `${newRequests} new request${newRequests === 1 ? "" : "s"}` : "No new requests"} />
        <DeskLink href="/staff/work" icon={<History className="size-4" aria-hidden />} label="My visits and requests" sub="Your visits and changes waiting for an owner" />
        <DeskLink href="/staff/search" icon={<Search className="size-4" aria-hidden />} label="Search" sub="Companies and support requests" />
      </nav>
      {error ? (
        <EmptyState title="Not available yet" description="Company access is not available on this database yet." />
      ) : (
        <div className="space-y-5">
          {inside && (
            <Panel>
              <PanelBody className="flex flex-wrap items-center gap-3">
                <div className="min-w-0 flex-1">
                  <p className="font-semibold text-ink">You are in {inside.name}</p>
                  <p className="text-sm text-muted">Until {formatDateTime(inside.my_visit_ends_at!)}. Its owners see that Taviron support is in their account.</p>
                </div>
                <a href="/command-center" className="text-sm font-semibold text-brand-fg hover:underline">Open it</a>
                <form action={leaveCompany}><SubmitButton variant="secondary" size="sm">Leave</SubmitButton></form>
              </PanelBody>
            </Panel>
          )}
          <form method="get" className="flex items-center gap-2" role="search" aria-label="Find a company">
            <div className="w-full max-w-sm"><Input name="q" defaultValue={sp.q ?? ""} placeholder="Find a company by name" aria-label="Company name" maxLength={80} /></div>
            <SubmitButton variant="secondary" size="sm">Find</SubmitButton>
            {q ? <a href="/staff" className="text-sm font-semibold whitespace-nowrap text-brand-fg hover:underline">Show all</a> : null}
          </form>
          <CompanyList title="Customer companies" rows={customers} health={healthById} now={now} empty={q ? "No customer company matches that name." : "No customer companies yet."} />
          {demos.length > 0 && <CompanyList title="Demo companies" rows={demos} health={healthById} now={now} empty="" />}
        </div>
      )}
    </>
  );
}

function DeskLink({ href, icon, label, sub }: { href: string; icon: ReactNode; label: string; sub: string }) {
  return (
    <Link href={href} className="console-press flex items-center gap-3 rounded-xl border border-line bg-card px-4 py-3 shadow-[0_1px_2px_rgb(12_26_43/0.04)] transition-colors hover:border-strong/40">
      <span className="text-brand-fg">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-ink">{label}</span>
        <span className="block text-xs text-muted">{sub}</span>
      </span>
      <ArrowRight className="size-4 text-muted" aria-hidden />
    </Link>
  );
}

/**
 * One row per company in the console's DataTable: a table from 768px, a card per company below (the reason box and
 * Go in at full width, nothing off the right edge of a phone).
 */
function CompanyList({ title, rows, health, now, empty }: { title: string; rows: Row[]; health: Map<string, CompanyHealth>; now: number; empty: string }) {
  return (
    <Panel>
      <PanelHeader title={title} description={title.startsWith("Customer") ? "Say briefly what you are helping with: the company sees it in its visit history." : "Fictional data; nothing real is sent from a demo."} />
      {rows.length === 0 ? (
        <PanelBody><p className="text-sm text-muted">{empty}</p></PanelBody>
      ) : (
        <DataTable frame={false} aria-label={title} head={<><DataHead>Company</DataHead><DataHead>Taviron access</DataHead><DataHead>Last visit</DataHead><DataHead align="right">Go in</DataHead></>}>
          {rows.map((r) => {
            const a = access(r);
            const h = health.get(r.id);
            return (
              <DataRow key={r.id}>
                <DataCell primary>
                  <span className="block font-semibold break-words text-ink">{r.name}</span>
                  <span className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted">
                    <span>{stageLabel(r.stage)}</span>
                    {h ? <HealthBadge health={h} now={now} /> : null}
                  </span>
                </DataCell>
                <DataCell label="Taviron access"><Badge tone={a.tone}>{a.label}</Badge></DataCell>
                <DataCell label="Last visit" className="text-sm whitespace-nowrap text-muted">{r.last_visit_at ? formatDateTime(r.last_visit_at) : "Never"}</DataCell>
                {/* No phone label: the reason box and Go in take the card's full width. */}
                <DataCell align="right" className="max-md:pt-2">
                  {r.my_visit_ends_at ? (
                    <a href="/command-center" className="text-sm font-semibold text-brand-fg hover:underline">Open (you are in)</a>
                  ) : r.can_enter ? (
                    <form action={enterCompany} className="flex flex-col gap-2 sm:flex-row sm:items-center md:justify-end" aria-label={`Go into ${r.name}`}>
                      <input type="hidden" name="company" value={r.id} />
                      <Input name="reason" placeholder="What are you helping with?" aria-label={`What are you helping ${r.name} with?`} maxLength={300} className="w-full sm:flex-1 md:w-56 md:flex-none" />
                      <SubmitButton size="sm">Go in</SubmitButton>
                    </form>
                  ) : (
                    <span className="text-xs text-muted">Waiting for the owner</span>
                  )}
                </DataCell>
              </DataRow>
            );
          })}
        </DataTable>
      )}
    </Panel>
  );
}
