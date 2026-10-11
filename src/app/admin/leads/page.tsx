import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/form";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/states";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
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
  owner_name: string | null;
  follow_up_on: string | null;
  submission_count: number;
  last_submitted_at: string;
}

export default async function LeadsPage({ searchParams }: { searchParams: Promise<{ q?: string; status?: string; due?: string }> }) {
  const sp = await searchParams;
  const q = (sp.q ?? "").slice(0, 100);
  const status = isLeadStatus(sp.status) ? sp.status : "";
  const due = sp.due === "1";
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("platform_leads", { p_search: q, p_status: status, p_due_only: due });
  const leads = (data ?? []) as LeadRow[];
  const today = new Date().toISOString().slice(0, 10);
  return (
    <>
      <PageHeader title="Leads" description="Demo requests and contact messages from the public website. Spam is hidden unless you filter for it." crumbs={[{ label: "Launchpad", href: "/admin" }, { label: "Leads" }]} />
      <form className="mb-4 flex flex-wrap items-end gap-2" role="search">
        <label className="min-w-56 flex-1 text-sm font-semibold">
          Search
          <Input name="q" defaultValue={q} placeholder="Name, email, company or message" className="mt-1" />
        </label>
        <label className="text-sm font-semibold">
          Status
          <Select name="status" defaultValue={status} className="mt-1">
            <option value="">All open and closed (not spam)</option>
            {LEAD_STATUSES.map((s) => (
              <option key={s} value={s}>
                {LEAD_STATUS_LABELS[s]}
              </option>
            ))}
          </Select>
        </label>
        <label className="flex h-10 items-center gap-2 text-sm font-semibold">
          <input type="checkbox" name="due" value="1" defaultChecked={due} className="size-4 accent-brand" /> Follow-up due
        </label>
        <button className={buttonClasses("dark")}>Search</button>
      </form>
      {error ? <p className="text-sm text-red-700">The leads could not be loaded.</p> : null}
      {leads.length === 0 ? (
        <EmptyState title={q || status || due ? "No leads match" : "No leads yet"} description="Leads appear here when someone sends the demo request or contact form on the website." />
      ) : (
        <TableWrap>
          <Table>
            <thead>
              <tr>
                <Th>Name</Th>
                <Th>Company</Th>
                <Th>Type</Th>
                <Th>Status</Th>
                <Th>Owner</Th>
                <Th>Follow-up</Th>
                <Th>Last message</Th>
              </tr>
            </thead>
            <tbody>
              {leads.map((l) => (
                <Tr key={l.id}>
                  <Td>
                    <Link href={`/admin/leads/${l.id}`} className="font-semibold hover:underline">
                      {l.name}
                    </Link>
                    <div className="text-xs text-muted">{l.email}</div>
                  </Td>
                  <Td>
                    {l.company_name || <span className="text-muted">—</span>}
                    {l.fleet_size ? <div className="text-xs text-muted">{l.fleet_size}</div> : null}
                  </Td>
                  <Td>{l.kind === "demo" ? "Demo request" : "Contact"}{l.submission_count > 1 ? <span className="text-xs text-muted"> · {l.submission_count}×</span> : null}</Td>
                  <Td>
                    <Badge tone={LEAD_STATUS_TONES[l.status]}>{LEAD_STATUS_LABELS[l.status]}</Badge>
                  </Td>
                  <Td>{l.owner_name ?? <span className="text-muted">Unassigned</span>}</Td>
                  <Td className={l.follow_up_on && l.follow_up_on <= today ? "font-semibold text-red-700" : undefined}>{l.follow_up_on ? formatDate(l.follow_up_on) : "—"}</Td>
                  <Td className="whitespace-nowrap">{formatDateTime(l.last_submitted_at)}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </TableWrap>
      )}
    </>
  );
}
