import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/form";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { ConsolePageHeader, DataCell, DataHead, DataRow, DataTable, FilterBar, FilterField, groupOf } from "@/components/admin/ui";
import { formatDate, formatDateTime } from "@/lib/dates";
import { LEAD_STATUSES, LEAD_STATUS_LABELS, LEAD_STATUS_TONES, isLeadStatus, type LeadStatus } from "@/lib/platform/leads";
import { createClient } from "@/server/supabase/server";

export const metadata = { title: "Leads" };

interface LeadRow {
  id: string;
  kind: "demo" | "contact";
  status: LeadStatus;
  name: string;
  email: string;
  company_name: string;
  fleet_size: string;
  truck_count: number | null;
  base_count: number | null;
  disposition: "" | "spam";
  owner_name: string | null;
  follow_up_on: string | null;
  submission_count: number;
  last_submitted_at: string;
}

export default async function LeadsPage({ searchParams }: { searchParams: Promise<{ q?: string; status?: string; due?: string }> }) {
  const sp = await searchParams;
  const q = (sp.q ?? "").slice(0, 100);
  const status = isLeadStatus(sp.status) || sp.status === "spam" ? sp.status : "";
  const due = sp.due === "1";
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("platform_leads", { p_search: q, p_status: status, p_due_only: due });
  const leads = (data ?? []) as LeadRow[];
  const today = new Date().toISOString().slice(0, 10);
  return (
    <>
      <ConsolePageHeader eyebrow={groupOf("/admin/leads")} title="Leads" description="Demo requests and contact messages from the public website. Leads flagged as spam are hidden unless you filter for them." />
      <FilterBar aria-label="Filter leads">
        <FilterField label="Search" grow>
          <Input name="q" defaultValue={q} placeholder="Name, email, company or message" />
        </FilterField>
        <FilterField label="Status" width="sm:w-64">
          <Select name="status" defaultValue={status}>
            <option value="">All statuses (not spam)</option>
            {LEAD_STATUSES.map((s) => (
              <option key={s} value={s}>
                {LEAD_STATUS_LABELS[s]}
              </option>
            ))}
            <option value="spam">Flagged as spam</option>
          </Select>
        </FilterField>
        <label className="flex h-10 items-center gap-2 text-sm font-medium text-ink">
          <input type="checkbox" name="due" value="1" defaultChecked={due} className="size-4 accent-brand" /> Follow-up due
        </label>
        <Button type="submit" variant="secondary">Search</Button>
      </FilterBar>
      {error ? (
        <ErrorState title="The leads could not be loaded" description="Nothing is shown rather than guessed. Try again in a moment." />
      ) : leads.length === 0 ? (
        <EmptyState title={q || status || due ? "No leads match" : "No leads yet"} description={q || status || due ? "Change the search or the filters to see more." : "Leads appear here when someone sends the demo request or contact form on the website."} className="rounded-xl border border-line bg-card" />
      ) : (
        <>
          <DataTable aria-label="Leads" head={<><DataHead>Name</DataHead><DataHead>Company</DataHead><DataHead>Type</DataHead><DataHead>Status</DataHead><DataHead>Owner</DataHead><DataHead>Follow-up</DataHead><DataHead>Last message</DataHead></>}>
            {leads.map((l) => {
              const overdue = Boolean(l.follow_up_on && l.follow_up_on <= today);
              return (
                <DataRow key={l.id}>
                  <DataCell primary>
                    <Link href={`/admin/leads/${l.id}`} className="font-semibold text-ink hover:text-brand-fg hover:underline">
                      {l.name}
                    </Link>
                    <div className="text-xs break-all text-muted">{l.email}</div>
                  </DataCell>
                  <DataCell label="Company" empty={!l.company_name}>
                    <span>
                      {l.company_name || <span className="text-muted">–</span>}
                      {l.truck_count !== null || l.base_count !== null ? (
                        <span className="block text-xs text-muted">
                          {l.truck_count ?? "–"} truck{l.truck_count === 1 ? "" : "s"} · {l.base_count ?? "–"} base{l.base_count === 1 ? "" : "s"}
                        </span>
                      ) : l.fleet_size ? (
                        <span className="block text-xs text-muted">{l.fleet_size}</span>
                      ) : null}
                    </span>
                  </DataCell>
                  <DataCell label="Type" className="whitespace-nowrap">{l.kind === "demo" ? "Demo request" : "Contact"}{l.submission_count > 1 ? <span className="text-xs text-muted"> · {l.submission_count}×</span> : null}</DataCell>
                  <DataCell label="Status">
                    <span className="inline-flex flex-wrap gap-1">
                      <Badge tone={LEAD_STATUS_TONES[l.status]}>{LEAD_STATUS_LABELS[l.status]}</Badge>
                      {l.disposition === "spam" ? <Badge tone="gray">Spam</Badge> : null}
                    </span>
                  </DataCell>
                  <DataCell label="Owner">{l.owner_name ?? <span className="text-muted">Unassigned</span>}</DataCell>
                  <DataCell label="Follow-up" empty={!l.follow_up_on} className={overdue ? "font-semibold whitespace-nowrap text-critical" : "whitespace-nowrap"}>
                    {l.follow_up_on ? <span>{formatDate(l.follow_up_on)}{overdue ? <span className="sr-only"> (due)</span> : null}</span> : "–"}
                  </DataCell>
                  <DataCell label="Last message" className="whitespace-nowrap text-muted tabular">{formatDateTime(l.last_submitted_at)}</DataCell>
                </DataRow>
              );
            })}
          </DataTable>
          <p className="mt-3 text-xs text-muted">{leads.length} lead{leads.length === 1 ? "" : "s"}{q || status || due ? (leads.length === 1 ? " matches" : " match") : ""}.</p>
        </>
      )}
    </>
  );
}
