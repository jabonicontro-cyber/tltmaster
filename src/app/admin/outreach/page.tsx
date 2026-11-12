import Link from "next/link";
import { AddProspectForm, OutreachImport, OutreachSettingsForm } from "@/components/admin/outreach";
import { Badge } from "@/components/ui/badge";
import { Button, ButtonLink, buttonClasses } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/form";
import { EmptyState, ErrorState, Notice } from "@/components/ui/states";
import { ConsolePageHeader, ConsoleTabs, DataCell, DataHead, DataRow, DataTable, FilterBar, FilterField, Panel, PanelBody, PanelHeader, StatGrid, groupOf } from "@/components/admin/ui";
import { formatDate } from "@/lib/dates";
import {
  OUTREACH_STATUSES, OUTREACH_STATUS_LABELS, SEGMENTS, SEGMENT_LABELS, settingsProblems, withDefaults,
  type OutreachSettings, type OutreachStatus, type Segment,
} from "@/lib/platform/outreach";
import { requirePlatformAdmin } from "@/server/platform";
import { createClient } from "@/server/supabase/server";

export const metadata = { title: "Outreach" };

const TONES: Record<OutreachStatus, "gray" | "blue" | "amber" | "green" | "dark"> = {
  new: "gray", contacted: "blue", replied: "amber", interested: "green", not_interested: "gray", do_not_contact: "dark",
};
const TABS = [
  { key: "list", label: "Companies" },
  { key: "add", label: "Add companies" },
  { key: "email", label: "Email and FAQ" },
] as const;
const PAGE = 100;

interface Row {
  id: string; email: string; company_name: string; contact_name: string; city: string; state: string; power_units: number | null;
  segment: Segment; status: OutreachStatus; last_contacted_at: string | null; suppressed: boolean;
}

type Search = { tab?: string; q?: string; status?: string; state?: string; segment?: string; min?: string; max?: string; page?: string };

/**
 * Outreach (master plan B139): find trucking and hauling companies, send each a personal email from your own mailbox,
 * and turn replies into leads. Platform team only.
 */
export default async function OutreachPage({ searchParams }: { searchParams: Promise<Search> }) {
  await requirePlatformAdmin();
  const sp = await searchParams;
  const tab = TABS.some((t) => t.key === sp.tab) ? sp.tab! : "list";
  const supabase = await createClient();
  const int = (v?: string) => (v && /^\d{1,6}$/.test(v) ? Number(v) : null);
  const page = Math.max(1, int(sp.page) ?? 1);
  const status = (OUTREACH_STATUSES as readonly string[]).includes(sp.status ?? "") ? sp.status! : "";
  const segment = (SEGMENTS as readonly string[]).includes(sp.segment ?? "") ? sp.segment! : "";
  const [list, settingsRes] = await Promise.all([
    supabase.rpc("platform_outreach_list", {
      p_search: (sp.q ?? "").slice(0, 100), p_status: status, p_state: (sp.state ?? "").slice(0, 2), p_segment: segment,
      p_min_units: int(sp.min), p_max_units: int(sp.max), p_limit: PAGE, p_offset: (page - 1) * PAGE,
    }),
    supabase.rpc("platform_outreach_settings"),
  ]);
  if (list.error || settingsRes.error) {
    return (
      <>
        <ConsolePageHeader eyebrow={groupOf("/admin/outreach")} title="Outreach" />
        <ErrorState title="Outreach isn't available yet" description="It needs a database update that has not been installed yet." />
      </>
    );
  }
  const data = list.data as { total: number; rows: Row[]; counts: Partial<Record<OutreachStatus, number>> };
  const settings = withDefaults(settingsRes.data as Partial<OutreachSettings>);
  const problems = settingsProblems(settings);
  const filtered = Boolean(sp.q || status || sp.state || segment || sp.min || sp.max);
  const href = (p: Record<string, string | number | undefined>) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...sp, ...p })) if (v !== undefined && v !== "") q.set(k, String(v));
    return `/admin/outreach?${q}`;
  };
  const allCount = Object.values(data.counts).reduce((a, b) => a + (b ?? 0), 0);

  return (
    <>
      <ConsolePageHeader
        eyebrow={groupOf("/admin/outreach")}
        title="Outreach"
        description="Find trucking and hauling companies, send each a personal email from your own mailbox, and turn replies into leads."
        actions={tab !== "add" ? <ButtonLink href="/admin/outreach?tab=add">Add companies</ButtonLink> : undefined}
      />
      <StatGrid
        label="Companies by status"
        columns={6}
        className="mb-6"
        stats={OUTREACH_STATUSES.map((st) => ({ label: OUTREACH_STATUS_LABELS[st], value: (data.counts[st] ?? 0).toLocaleString(), href: `/admin/outreach?status=${st}` }))}
      />
      {problems.length > 0 && (
        <div className="mb-5">
          <Notice tone="warning" title="Finish the email before reaching out">
            {problems.join(" ")} <Link className="font-semibold underline" href="/admin/outreach?tab=email">Email and FAQ</Link>
          </Notice>
        </div>
      )}
      <ConsoleTabs label="Outreach" className="mb-5" items={TABS.map((t) => ({ href: `/admin/outreach?tab=${t.key}`, label: t.label, current: tab === t.key }))} />

      {tab === "add" && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <Panel>
            <PanelHeader title="From the FMCSA carrier registry" description="Public registration data, including the email address each carrier gives FMCSA." />
            <PanelBody><OutreachImport /></PanelBody>
          </Panel>
          <Panel className="self-start">
            <PanelHeader title="One company" description="Someone you met, a referral, or a company you found yourself." />
            <PanelBody><AddProspectForm /></PanelBody>
          </Panel>
        </div>
      )}

      {tab === "email" && (
        <Panel>
          <PanelHeader title="Email and FAQ" description="One email for everyone, filled in for each company. Keep it personal and short; every claim must be true today." />
          <PanelBody><OutreachSettingsForm initial={settings} /></PanelBody>
        </Panel>
      )}

      {tab === "list" && (
        <>
          <FilterBar aria-label="Filter outreach companies">
            <FilterField label="Search" grow><Input name="q" defaultValue={sp.q ?? ""} placeholder="Company, email, contact, city or DOT number" /></FilterField>
            <FilterField label="Status" width="sm:w-36">
              <Select name="status" defaultValue={status}>
                <option value="">Any</option>
                {OUTREACH_STATUSES.map((s) => <option key={s} value={s}>{OUTREACH_STATUS_LABELS[s]}</option>)}
              </Select>
            </FilterField>
            <FilterField label="Kind" width="sm:w-44">
              <Select name="segment" defaultValue={segment}>
                <option value="">Any</option>
                {SEGMENTS.map((s) => <option key={s} value={s}>{SEGMENT_LABELS[s]}</option>)}
              </Select>
            </FilterField>
            <FilterField label="State" width="sm:w-20"><Input name="state" defaultValue={sp.state ?? ""} maxLength={2} /></FilterField>
            <FilterField label="Trucks from" width="sm:w-24"><Input name="min" inputMode="numeric" defaultValue={sp.min ?? ""} /></FilterField>
            <FilterField label="up to" width="sm:w-24"><Input name="max" inputMode="numeric" defaultValue={sp.max ?? ""} /></FilterField>
            <Button type="submit" variant="secondary">Search</Button>
          </FilterBar>
          {data.rows.length === 0 ? (
            <EmptyState
              title={filtered ? "No companies match" : "No companies yet"}
              description={filtered ? "Try other filters." : "Add companies from the FMCSA carrier registry or one at a time."}
              action={!filtered ? <Link className={buttonClasses("secondary")} href="/admin/outreach?tab=add">Add companies</Link> : undefined}
              className="rounded-xl border border-line bg-card"
            />
          ) : (
            <>
              <p className="mb-3 text-sm text-muted">{data.total.toLocaleString()} {filtered ? "matching" : "of " + allCount.toLocaleString()} {data.total === 1 ? "company" : "companies"}</p>
              <DataTable aria-label="Outreach companies" head={<><DataHead>Company</DataHead><DataHead>Where</DataHead><DataHead align="right">Trucks</DataHead><DataHead>Kind</DataHead><DataHead>Status</DataHead><DataHead>Last contact</DataHead></>}>
                {data.rows.map((r) => (
                  <DataRow key={r.id}>
                    <DataCell primary>
                      <Link href={`/admin/outreach/${r.id}`} className="font-semibold text-ink hover:text-brand-fg hover:underline">{r.company_name}</Link>
                      <div className="text-xs break-all text-muted">{r.contact_name ? `${r.contact_name} · ` : ""}{r.email}</div>
                    </DataCell>
                    <DataCell label="Where" empty={!r.city && !r.state}>{[r.city, r.state].filter(Boolean).join(", ") || <span className="text-muted">–</span>}</DataCell>
                    <DataCell label="Trucks" align="right">{r.power_units ?? "–"}</DataCell>
                    <DataCell label="Kind">{SEGMENT_LABELS[r.segment]}</DataCell>
                    <DataCell label="Status"><Badge tone={TONES[r.status]}>{OUTREACH_STATUS_LABELS[r.status]}</Badge></DataCell>
                    <DataCell label="Last contact" className="whitespace-nowrap text-muted tabular">{r.last_contacted_at ? formatDate(r.last_contacted_at.slice(0, 10)) : "–"}</DataCell>
                  </DataRow>
                ))}
              </DataTable>
              {data.total > PAGE && (
                <div className="mt-4 flex items-center gap-3 text-sm">
                  {page > 1 && <Link className={buttonClasses("secondary", "sm")} href={href({ page: page - 1 })}>Previous</Link>}
                  <span className="text-muted">Page {page} of {Math.ceil(data.total / PAGE)}</span>
                  {page * PAGE < data.total && <Link className={buttonClasses("secondary", "sm")} href={href({ page: page + 1 })}>Next</Link>}
                </div>
              )}
            </>
          )}
        </>
      )}
    </>
  );
}
