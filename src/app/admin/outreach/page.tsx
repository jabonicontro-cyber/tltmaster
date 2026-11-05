import Link from "next/link";
import { AddProspectForm, OutreachImport, OutreachSettingsForm } from "@/components/admin/outreach";
import { Badge } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Input, Select } from "@/components/ui/form";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState, ErrorState, Notice } from "@/components/ui/states";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { cn } from "@/lib/cn";
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
        <PageHeader title="Outreach" crumbs={[{ label: "Launchpad", href: "/admin" }, { label: "Outreach" }]} />
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
      <PageHeader
        title="Outreach"
        description="Find trucking and hauling companies, send each a personal email from your own mailbox, and turn replies into leads."
        crumbs={[{ label: "Launchpad", href: "/admin" }, { label: "Outreach" }]}
      />
      <ul className="mb-4 flex flex-wrap gap-2 text-sm" aria-label="Companies by status">
        {OUTREACH_STATUSES.map((s) => (
          <li key={s}>
            <Link href={`/admin/outreach?status=${s}`} className="inline-flex items-center gap-1.5 rounded-full border border-line bg-card px-3 py-1 hover:border-strong/40">
              {OUTREACH_STATUS_LABELS[s]} <span className="font-semibold tabular-nums">{(data.counts[s] ?? 0).toLocaleString()}</span>
            </Link>
          </li>
        ))}
      </ul>
      {problems.length > 0 && (
        <div className="mb-4">
          <Notice tone="warning" title="Finish the email before reaching out">
            {problems.join(" ")} <Link className="font-semibold underline" href="/admin/outreach?tab=email">Email and FAQ</Link>
          </Notice>
        </div>
      )}
      <nav aria-label="Outreach" className="mb-4 flex gap-1 border-b border-line">
        {TABS.map((t) => (
          <Link key={t.key} href={`/admin/outreach?tab=${t.key}`} aria-current={tab === t.key ? "page" : undefined}
            className={cn("-mb-px border-b-2 px-3 py-2 text-sm font-semibold", tab === t.key ? "border-strong text-ink" : "border-transparent text-muted hover:text-ink")}>
            {t.label}
          </Link>
        ))}
      </nav>

      {tab === "add" && (
        <div className="grid gap-5 lg:grid-cols-2">
          <Card>
            <CardHeader title="From the FMCSA carrier registry" description="Public registration data, including the email address each carrier gives FMCSA." />
            <CardBody><OutreachImport /></CardBody>
          </Card>
          <Card>
            <CardHeader title="One company" description="Someone you met, a referral, or a company you found yourself." />
            <CardBody><AddProspectForm /></CardBody>
          </Card>
        </div>
      )}

      {tab === "email" && (
        <Card>
          <CardHeader title="Email and FAQ" description="One email for everyone, filled in for each company. Keep it personal and short; every claim must be true today." />
          <CardBody><OutreachSettingsForm initial={settings} /></CardBody>
        </Card>
      )}

      {tab === "list" && (
        <>
          <form className="mb-4 flex flex-wrap items-end gap-2" role="search">
            <label className="min-w-48 flex-1 text-sm font-semibold">Search<Input name="q" defaultValue={sp.q ?? ""} placeholder="Company, email, contact, city or DOT number" className="mt-1" /></label>
            <label className="text-sm font-semibold">Status
              <Select name="status" defaultValue={status} className="mt-1">
                <option value="">Any</option>
                {OUTREACH_STATUSES.map((s) => <option key={s} value={s}>{OUTREACH_STATUS_LABELS[s]}</option>)}
              </Select>
            </label>
            <label className="text-sm font-semibold">Kind
              <Select name="segment" defaultValue={segment} className="mt-1">
                <option value="">Any</option>
                {SEGMENTS.map((s) => <option key={s} value={s}>{SEGMENT_LABELS[s]}</option>)}
              </Select>
            </label>
            <label className="w-20 text-sm font-semibold">State<Input name="state" defaultValue={sp.state ?? ""} maxLength={2} className="mt-1" /></label>
            <label className="w-24 text-sm font-semibold">Trucks from<Input name="min" inputMode="numeric" defaultValue={sp.min ?? ""} className="mt-1" /></label>
            <label className="w-24 text-sm font-semibold">up to<Input name="max" inputMode="numeric" defaultValue={sp.max ?? ""} className="mt-1" /></label>
            <button className={buttonClasses("dark")}>Search</button>
          </form>
          {data.rows.length === 0 ? (
            <EmptyState
              title={filtered ? "No companies match" : "No companies yet"}
              description={filtered ? "Try other filters." : "Add companies from the FMCSA carrier registry or one at a time."}
              action={!filtered ? <Link className={buttonClasses("primary")} href="/admin/outreach?tab=add">Add companies</Link> : undefined}
            />
          ) : (
            <>
              <p className="mb-2 text-sm text-muted">{data.total.toLocaleString()} {filtered ? "matching" : "of " + allCount.toLocaleString()} {data.total === 1 ? "company" : "companies"}</p>
              <TableWrap>
                <Table aria-label="Outreach companies">
                  <thead>
                    <tr><Th>Company</Th><Th>Where</Th><Th>Trucks</Th><Th>Kind</Th><Th>Status</Th><Th>Last contact</Th></tr>
                  </thead>
                  <tbody>
                    {data.rows.map((r) => (
                      <Tr key={r.id}>
                        <Td>
                          <Link href={`/admin/outreach/${r.id}`} className="font-semibold hover:underline">{r.company_name}</Link>
                          <div className="text-xs text-muted">{r.contact_name ? `${r.contact_name} · ` : ""}{r.email}</div>
                        </Td>
                        <Td>{[r.city, r.state].filter(Boolean).join(", ") || <span className="text-muted">–</span>}</Td>
                        <Td className="tabular">{r.power_units ?? "–"}</Td>
                        <Td>{SEGMENT_LABELS[r.segment]}</Td>
                        <Td><Badge tone={TONES[r.status]}>{OUTREACH_STATUS_LABELS[r.status]}</Badge></Td>
                        <Td className="whitespace-nowrap">{r.last_contacted_at ? formatDate(r.last_contacted_at.slice(0, 10)) : "–"}</Td>
                      </Tr>
                    ))}
                  </tbody>
                </Table>
              </TableWrap>
              {data.total > PAGE && (
                <div className="mt-3 flex items-center gap-3 text-sm">
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
